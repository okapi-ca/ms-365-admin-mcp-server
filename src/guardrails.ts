/**
 * Pre-flight guardrails for privilege-revocation tools.
 *
 * Microsoft Graph rejects some of these operations on its own, but it does so
 * with a bare 4xx that names neither the cause nor the remedy — and in the case
 * that motivated this module it does not reject at all: removing the sole owner
 * of a *security* group succeeds and silently leaves the group ownerless, with
 * no supported way to adopt it afterwards.
 *
 * Five checks, in the order they appear in the brief:
 *
 *   1. last owner            — refuse; name the group and point at add-group-owner
 *   2. dynamic group         — refuse; membership is computed from membershipRule
 *   3. on-premises-synced    — refuse; the write belongs in Active Directory
 *   4. last Global Admin     — refuse, unconditionally (anti-lockout)
 *   5. role-assignable group — explain the extra permission if Graph answers 403
 *
 * Failure posture differs by check, deliberately:
 *
 *   - Checks 1-3 **fail open**. Their pre-flight read is a convenience: Graph
 *     still adjudicates the write, and a throttled or unauthorised read must not
 *     block a legitimate offboarding. The skipped check is reported back to the
 *     operator as a notice rather than swallowed.
 *   - Check 4 **fails closed**. It is the only check standing between a typo and
 *     an unrecoverable tenant lockout, so a pre-flight read that cannot be
 *     completed is itself a refusal. No parameter overrides it.
 *
 * Check 5 is not a refusal at all: it annotates an error Graph has already
 * returned. Kept here so all five live in one auditable place.
 *
 * Pure logic with an injected reader, so every branch is unit-testable without
 * the MCP or MSAL stack.
 */

import logger from './logger.js';

/**
 * Well-known roleTemplateId of the Global Administrator role. For built-in
 * directory roles the unifiedRoleDefinition id is the template id, so the same
 * constant matches both `roleAssignments.roleDefinitionId` and
 * `directoryRoles.roleTemplateId`.
 */
export const GLOBAL_ADMINISTRATOR_ROLE_TEMPLATE_ID = '62e90394-69f5-4237-9190-012177145e10';

/** Upper bound on principal look-ups while counting surviving Global Admins. */
const MAX_PRINCIPAL_PROBES = 25;

/**
 * Reads a Graph path and resolves the parsed body. Must reject on any Graph
 * error, and must NOT strip `@odata.type` — the last-Global-Admin count needs it
 * to tell a role-assignable group apart from a disabled user.
 */
export type GraphReader = (path: string) => Promise<Record<string, unknown>>;

export interface GuardrailResult {
  /** True when the tool must not reach Graph. */
  blocked: boolean;
  /** Operator-facing explanation. Present iff `blocked`. */
  reason?: string;
  /** Server-generated notes to surface alongside the response (skipped checks). */
  notices: string[];
  /** Context to append should Graph answer the write with a 403. */
  errorHints: string[];
}

const GROUP_TOOLS = new Set(['remove-group-member', 'remove-group-owner', 'add-group-owner']);
const ROLE_TOOLS = new Set(['delete-role-assignment', 'remove-directory-role-member']);

export function hasGuardrails(toolName: string): boolean {
  return GROUP_TOOLS.has(toolName) || ROLE_TOOLS.has(toolName);
}

function allow(notices: string[] = [], errorHints: string[] = []): GuardrailResult {
  return { blocked: false, notices, errorHints };
}

function block(reason: string): GuardrailResult {
  return { blocked: true, reason, notices: [], errorHints: [] };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function collection(record: Record<string, unknown>): Record<string, unknown>[] {
  const value = record.value;
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** Path segments are operator-supplied ids; encode before interpolation. */
function seg(value: unknown): string {
  return encodeURIComponent(String(value ?? ''));
}

export async function runGuardrails(
  toolName: string,
  params: Record<string, unknown>,
  read: GraphReader
): Promise<GuardrailResult> {
  if (GROUP_TOOLS.has(toolName)) {
    return groupGuardrails(toolName, params, read);
  }
  if (ROLE_TOOLS.has(toolName)) {
    return roleGuardrails(toolName, params, read);
  }
  return allow();
}

/**
 * Checks 1, 2, 3 and 5 — group membership and ownership writes. Fails open.
 *
 * `groupId` / `directoryObjectId` are the camelCase path-parameter names the
 * Zodios shim derives from the endpoint path, which is what reaches this layer.
 */
async function groupGuardrails(
  toolName: string,
  params: Record<string, unknown>,
  read: GraphReader
): Promise<GuardrailResult> {
  const groupId = params.groupId;
  const targetId = params.directoryObjectId;
  if (typeof groupId !== 'string' || groupId === '') {
    // No group to inspect — let Graph produce its own routing error.
    return allow();
  }

  const notices: string[] = [];
  const errorHints: string[] = [];

  let group: Record<string, unknown>;
  try {
    group = await read(
      `/groups/${seg(groupId)}?$select=id,displayName,membershipRule,onPremisesSyncEnabled,isAssignableToRole`
    );
  } catch (error) {
    logger.warn(`Guardrail pre-flight read failed for ${toolName} on group ${groupId}`);
    return allow([
      `Guardrail notice: the group could not be read before this write (${message(error)}). ` +
        'The dynamic-group, on-premises-sync and last-owner checks were skipped for this call — ' +
        'Microsoft Graph alone validated it. Re-run once the read works if you want those checks applied.',
    ]);
  }

  const label = str(group, 'displayName') ?? groupId;

  // Check 3 — on-premises-synced group. Graph will not accept the write and the
  // authoritative copy lives in AD, so say that instead of relaying a 4xx.
  if (group.onPremisesSyncEnabled === true) {
    return block(
      `Refused: group "${label}" is synchronised from on-premises Active Directory ` +
        '(onPremisesSyncEnabled is true). Membership and ownership of a synced group must be ' +
        'changed in AD; a change written to Entra ID would be reverted by the next sync cycle. ' +
        'Make the change in Active Directory and let it flow through Entra Connect / Cloud Sync.'
    );
  }

  // Check 2 — dynamic group. Membership is a computed projection of the rule, so
  // removing a member is not a meaningful operation. Owners are still explicit.
  const membershipRule = str(group, 'membershipRule');
  if (toolName === 'remove-group-member' && membershipRule !== undefined && membershipRule !== '') {
    return block(
      `Refused: group "${label}" is a dynamic group — its membership is computed from a ` +
        'membershipRule, not stored, so a member cannot be removed directly. Any removal would ' +
        'be recalculated away on the next evaluation. To drop this user, change the rule or the ' +
        'user attributes it selects on. Current rule: ' +
        membershipRule
    );
  }

  // Check 5 — role-assignable group needs a permission beyond the tool's own.
  // Not a refusal: recorded so a 403 from Graph can be explained rather than relayed raw.
  if (group.isAssignableToRole === true) {
    errorHints.push(
      `Group "${label}" is role-assignable (isAssignableToRole is true). Writes to such a group ` +
        'require RoleManagement.ReadWrite.Directory in addition to the permission this tool ' +
        'normally needs. If the call was denied, that missing permission is the likely cause — ' +
        'grant it on the app registration and retry.'
    );
  }

  // Check 1 — last owner. The motivating incident: for a security group Graph
  // accepts this and leaves the group ownerless with no adoption path.
  if (toolName === 'remove-group-owner' && typeof targetId === 'string' && targetId !== '') {
    try {
      const owners = await read(`/groups/${seg(groupId)}/owners?$select=id&$top=2`);
      const ownerIds = collection(owners)
        .map((owner) => str(owner, 'id'))
        .filter((id): id is string => id !== undefined);

      if (ownerIds.length === 1 && ownerIds[0] === targetId) {
        return block(
          `Refused: this principal is the only owner of group "${label}". Removing it would leave ` +
            'the group ownerless, and an ownerless group cannot be adopted through Microsoft ' +
            'Graph afterwards. Add a replacement owner first with add-group-owner, then re-run ' +
            'this removal. Note that for a security group Graph does not refuse this on its own — ' +
            'the group would simply end up unowned.'
        );
      }
    } catch (error) {
      logger.warn(`Guardrail owner-count read failed for ${toolName} on group ${groupId}`);
      notices.push(
        `Guardrail notice: the group's owner list could not be read (${message(error)}), so the ` +
          'last-owner check was skipped for this call. If this principal was the only owner, the ' +
          'group is now ownerless — confirm with list-group-owners and repair with add-group-owner.'
      );
    }
  }

  return allow(notices, errorHints);
}

/**
 * Check 4 — last active Global Administrator. Fails closed: a pre-flight read
 * that cannot be completed blocks the write, because the failure mode it guards
 * against is losing administrative access to the tenant outright.
 */
async function roleGuardrails(
  toolName: string,
  params: Record<string, unknown>,
  read: GraphReader
): Promise<GuardrailResult> {
  if (toolName === 'delete-role-assignment') {
    const assignmentId = params.unifiedRoleAssignmentId;
    if (typeof assignmentId !== 'string' || assignmentId === '') return allow();

    let assignment: Record<string, unknown>;
    try {
      assignment = await read(
        `/roleManagement/directory/roleAssignments/${seg(assignmentId)}?$select=id,principalId,roleDefinitionId`
      );
    } catch (error) {
      return block(antiLockoutUnverifiable(`the role assignment could not be read`, error));
    }

    if (str(assignment, 'roleDefinitionId') !== GLOBAL_ADMINISTRATOR_ROLE_TEMPLATE_ID) {
      return allow();
    }
    return lastGlobalAdminCheckByAssignment(assignmentId, read);
  }

  // remove-directory-role-member
  const roleId = params.directoryRoleId;
  const memberId = params.directoryObjectId;
  if (typeof roleId !== 'string' || roleId === '') return allow();

  let role: Record<string, unknown>;
  try {
    role = await read(`/directoryRoles/${seg(roleId)}?$select=id,displayName,roleTemplateId`);
  } catch (error) {
    return block(antiLockoutUnverifiable('the directory role could not be read', error));
  }

  if (str(role, 'roleTemplateId') !== GLOBAL_ADMINISTRATOR_ROLE_TEMPLATE_ID) {
    return allow();
  }

  let members: Record<string, unknown>;
  try {
    members = await read(`/directoryRoles/${seg(roleId)}/members`);
  } catch (error) {
    return block(antiLockoutUnverifiable('the role members could not be listed', error));
  }

  const survivors = collection(members).filter(
    (member) => str(member, 'id') !== memberId && isActiveRoleHolder(member)
  );
  if (survivors.length === 0) {
    return block(lastGlobalAdminRefusal());
  }
  return allow();
}

/**
 * Counts Global Administrator assignments other than the one being deleted and
 * stops at the first holder that is demonstrably still usable. Anything it
 * cannot positively confirm as active is treated as inactive, so uncertainty
 * pushes towards refusing.
 */
async function lastGlobalAdminCheckByAssignment(
  assignmentId: string,
  read: GraphReader
): Promise<GuardrailResult> {
  let assignments: Record<string, unknown>;
  try {
    assignments = await read(
      `/roleManagement/directory/roleAssignments?$select=id,principalId&$filter=roleDefinitionId eq '${GLOBAL_ADMINISTRATOR_ROLE_TEMPLATE_ID}'`
    );
  } catch (error) {
    return block(
      antiLockoutUnverifiable(
        'the Global Administrator assignments in this tenant could not be listed',
        error
      )
    );
  }

  const others = collection(assignments)
    .filter((entry) => str(entry, 'id') !== assignmentId)
    .map((entry) => str(entry, 'principalId'))
    .filter((id): id is string => id !== undefined);

  if (others.length === 0) {
    return block(lastGlobalAdminRefusal());
  }

  const probes = others.slice(0, MAX_PRINCIPAL_PROBES);
  for (const principalId of probes) {
    let principal: Record<string, unknown>;
    try {
      principal = await read(`/directoryObjects/${seg(principalId)}`);
    } catch {
      // Unreadable principal cannot be counted as a survivor.
      logger.warn(`Guardrail could not read Global Administrator principal ${principalId}`);
      continue;
    }
    if (isActiveRoleHolder(principal)) return allow();
  }

  if (others.length > probes.length) {
    // More holders than we probed, none of the probed ones usable. Refusing here
    // would be wrong: the tenant plainly has other Global Admins.
    return allow([
      `Guardrail notice: this tenant has ${others.length} Global Administrator assignments; ` +
        `only the first ${probes.length} were checked for an enabled account. The anti-lockout ` +
        'check passed on count alone.',
    ]);
  }

  return block(lastGlobalAdminRefusal());
}

/**
 * A directory object still capable of exercising a role assignment. Groups count
 * as active holders — a role-assignable group confers the role on its members,
 * and the group itself has no accountEnabled. Absent `accountEnabled` on a
 * non-group object is treated as inactive so unknowns bias towards refusing.
 */
function isActiveRoleHolder(principal: Record<string, unknown>): boolean {
  const odataType = str(principal, '@odata.type')?.toLowerCase() ?? '';
  if (odataType.includes('group')) return true;
  return principal.accountEnabled === true;
}

function lastGlobalAdminRefusal(): string {
  return (
    'Refused: this is the last active Global Administrator in the tenant. Removing it would ' +
    'leave nobody able to administer Entra ID, and the loss is not self-recoverable — regaining ' +
    'access requires a Microsoft support escalation. This refusal is unconditional and cannot be ' +
    'overridden by any parameter of this tool. Assign Global Administrator to another enabled ' +
    'account with add-directory-role-member, verify it with list-role-assignments, then re-run ' +
    'this removal.'
  );
}

function antiLockoutUnverifiable(what: string, error: unknown): string {
  return (
    `Refused: ${what} (${message(error)}), so the anti-lockout check could not be completed. ` +
    'This tool refuses rather than proceed blind, because the operation it guards can remove the ' +
    "tenant's last Global Administrator irreversibly. Resolve the read failure — most often a " +
    'missing RoleManagement.Read.Directory / Directory.Read.All grant, or Graph throttling — and ' +
    'retry.'
  );
}
