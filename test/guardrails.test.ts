import { describe, it, expect } from 'vitest';
import {
  hasGuardrails,
  runGuardrails,
  GLOBAL_ADMINISTRATOR_ROLE_TEMPLATE_ID as GA,
  type GraphReader,
} from '../src/guardrails.js';

const GROUP = 'aaaaaaaa-0000-0000-0000-000000000001';
const TARGET = 'bbbbbbbb-0000-0000-0000-000000000002';
const OTHER = 'cccccccc-0000-0000-0000-000000000003';
const ASSIGNMENT = 'dddddddd-0000-0000-0000-000000000004';
const ROLE = 'eeeeeeee-0000-0000-0000-000000000005';

/**
 * Reader backed by a path→body map. Any path matched by a `reject` prefix throws,
 * which is how the fail-open / fail-closed branches are exercised. Records the
 * calls so tests can assert a check short-circuited before a needless read.
 */
function reader(
  bodies: Record<string, unknown>,
  reject: string[] = []
): GraphReader & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (endpoint: string) => {
    calls.push(endpoint);
    if (reject.some((prefix) => endpoint.startsWith(prefix))) {
      throw new Error('Microsoft Graph API error: 429 Too Many Requests');
    }
    const key = Object.keys(bodies).find((candidate) => endpoint.startsWith(candidate));
    if (key === undefined) throw new Error(`unstubbed read: ${endpoint}`);
    return bodies[key] as Record<string, unknown>;
  };
  return Object.assign(fn, { calls });
}

const plainGroup = { id: GROUP, displayName: 'Test-Group' };

describe('hasGuardrails', () => {
  it('covers the group and role revocation tools', () => {
    for (const tool of [
      'remove-group-member',
      'remove-group-owner',
      'add-group-owner',
      'delete-role-assignment',
      'remove-directory-role-member',
    ]) {
      expect(hasGuardrails(tool), tool).toBe(true);
    }
  });

  it('leaves every other tool untouched', () => {
    for (const tool of ['list-users', 'add-group-member', 'delete-group', 'delete-oauth2-grant']) {
      expect(hasGuardrails(tool), tool).toBe(false);
    }
  });
});

describe('guardrail 1 — last owner', () => {
  it('refuses when the target is the only owner', async () => {
    const read = reader({
      [`/groups/${GROUP}?`]: plainGroup,
      [`/groups/${GROUP}/owners?`]: { value: [{ id: TARGET }] },
    });

    const result = await runGuardrails(
      'remove-group-owner',
      { groupId: GROUP, directoryObjectId: TARGET },
      read
    );

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('only owner');
    expect(result.reason).toContain('add-group-owner');
    expect(result.reason).toContain('Test-Group');
  });

  it('allows the removal once a second owner exists', async () => {
    const read = reader({
      [`/groups/${GROUP}?`]: plainGroup,
      [`/groups/${GROUP}/owners?`]: { value: [{ id: TARGET }, { id: OTHER }] },
    });

    const result = await runGuardrails(
      'remove-group-owner',
      { groupId: GROUP, directoryObjectId: TARGET },
      read
    );

    expect(result.blocked).toBe(false);
  });

  it('allows when the sole owner is somebody other than the target', async () => {
    const read = reader({
      [`/groups/${GROUP}?`]: plainGroup,
      [`/groups/${GROUP}/owners?`]: { value: [{ id: OTHER }] },
    });

    const result = await runGuardrails(
      'remove-group-owner',
      { groupId: GROUP, directoryObjectId: TARGET },
      read
    );

    expect(result.blocked).toBe(false);
  });

  it('does not run for member removal', async () => {
    const read = reader({ [`/groups/${GROUP}?`]: plainGroup });

    const result = await runGuardrails(
      'remove-group-member',
      { groupId: GROUP, directoryObjectId: TARGET },
      read
    );

    expect(result.blocked).toBe(false);
    expect(read.calls.some((c) => c.includes('/owners'))).toBe(false);
  });

  it('fails open with a notice when the owner list cannot be read', async () => {
    const read = reader({ [`/groups/${GROUP}?`]: plainGroup }, [`/groups/${GROUP}/owners`]);

    const result = await runGuardrails(
      'remove-group-owner',
      { groupId: GROUP, directoryObjectId: TARGET },
      read
    );

    expect(result.blocked).toBe(false);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain('last-owner check was skipped');
    expect(result.notices[0]).toContain('429');
  });
});

describe('guardrail 2 — dynamic group', () => {
  const dynamic = { ...plainGroup, membershipRule: '(user.department -eq "Design")' };

  it('refuses a member removal and quotes the rule', async () => {
    const read = reader({ [`/groups/${GROUP}?`]: dynamic });

    const result = await runGuardrails(
      'remove-group-member',
      { groupId: GROUP, directoryObjectId: TARGET },
      read
    );

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('dynamic group');
    expect(result.reason).toContain('(user.department -eq "Design")');
  });

  it('still allows owner writes — ownership is explicit, not computed', async () => {
    const read = reader({
      [`/groups/${GROUP}?`]: dynamic,
      [`/groups/${GROUP}/owners?`]: { value: [{ id: TARGET }, { id: OTHER }] },
    });

    const removeOwner = await runGuardrails(
      'remove-group-owner',
      { groupId: GROUP, directoryObjectId: TARGET },
      read
    );
    const addOwner = await runGuardrails('add-group-owner', { groupId: GROUP }, read);

    expect(removeOwner.blocked).toBe(false);
    expect(addOwner.blocked).toBe(false);
  });

  it('ignores an empty membershipRule', async () => {
    const read = reader({ [`/groups/${GROUP}?`]: { ...plainGroup, membershipRule: '' } });

    const result = await runGuardrails(
      'remove-group-member',
      { groupId: GROUP, directoryObjectId: TARGET },
      read
    );

    expect(result.blocked).toBe(false);
  });
});

describe('guardrail 3 — on-premises-synced group', () => {
  const synced = { ...plainGroup, onPremisesSyncEnabled: true };

  it.each(['remove-group-member', 'remove-group-owner', 'add-group-owner'])(
    'refuses %s and points at Active Directory',
    async (tool) => {
      const read = reader({ [`/groups/${GROUP}?`]: synced });

      const result = await runGuardrails(tool, { groupId: GROUP, directoryObjectId: TARGET }, read);

      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('on-premises Active Directory');
      expect(result.reason).toContain('onPremisesSyncEnabled');
    }
  );

  it('takes precedence over the dynamic-group check', async () => {
    const read = reader({
      [`/groups/${GROUP}?`]: { ...synced, membershipRule: 'user.city -eq "Montreal"' },
    });

    const result = await runGuardrails(
      'remove-group-member',
      { groupId: GROUP, directoryObjectId: TARGET },
      read
    );

    expect(result.reason).toContain('on-premises Active Directory');
  });
});

describe('guardrail 4 — last active Global Administrator', () => {
  describe('delete-role-assignment', () => {
    it('ignores an assignment for any other role', async () => {
      const read = reader({
        [`/roleManagement/directory/roleAssignments/${ASSIGNMENT}?`]: {
          id: ASSIGNMENT,
          principalId: TARGET,
          roleDefinitionId: '11111111-2222-3333-4444-555555555555',
        },
      });

      const result = await runGuardrails(
        'delete-role-assignment',
        { unifiedRoleAssignmentId: ASSIGNMENT },
        read
      );

      expect(result.blocked).toBe(false);
      // No point listing tenant Global Admins for a Purview role.
      expect(read.calls.some((c) => c.includes('$filter'))).toBe(false);
    });

    it('refuses when it is the only Global Administrator assignment', async () => {
      const read = reader({
        [`/roleManagement/directory/roleAssignments/${ASSIGNMENT}?`]: {
          id: ASSIGNMENT,
          principalId: TARGET,
          roleDefinitionId: GA,
        },
        '/roleManagement/directory/roleAssignments?': { value: [{ id: ASSIGNMENT }] },
      });

      const result = await runGuardrails(
        'delete-role-assignment',
        { unifiedRoleAssignmentId: ASSIGNMENT },
        read
      );

      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('last active Global Administrator');
      expect(result.reason).toContain('cannot be overridden');
    });

    it('refuses when every other Global Administrator account is disabled', async () => {
      const read = reader({
        [`/roleManagement/directory/roleAssignments/${ASSIGNMENT}?`]: {
          id: ASSIGNMENT,
          principalId: TARGET,
          roleDefinitionId: GA,
        },
        '/roleManagement/directory/roleAssignments?': {
          value: [
            { id: ASSIGNMENT, principalId: TARGET },
            { id: 'other-assignment', principalId: OTHER },
          ],
        },
        [`/directoryObjects/${OTHER}`]: {
          '@odata.type': '#microsoft.graph.user',
          id: OTHER,
          accountEnabled: false,
        },
      });

      const result = await runGuardrails(
        'delete-role-assignment',
        { unifiedRoleAssignmentId: ASSIGNMENT },
        read
      );

      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('last active Global Administrator');
    });

    it('allows when another enabled Global Administrator survives', async () => {
      const read = reader({
        [`/roleManagement/directory/roleAssignments/${ASSIGNMENT}?`]: {
          id: ASSIGNMENT,
          principalId: TARGET,
          roleDefinitionId: GA,
        },
        '/roleManagement/directory/roleAssignments?': {
          value: [
            { id: ASSIGNMENT, principalId: TARGET },
            { id: 'other-assignment', principalId: OTHER },
          ],
        },
        [`/directoryObjects/${OTHER}`]: {
          '@odata.type': '#microsoft.graph.user',
          id: OTHER,
          accountEnabled: true,
        },
      });

      const result = await runGuardrails(
        'delete-role-assignment',
        { unifiedRoleAssignmentId: ASSIGNMENT },
        read
      );

      expect(result.blocked).toBe(false);
    });

    it('counts a role-assignable group as a surviving holder', async () => {
      const read = reader({
        [`/roleManagement/directory/roleAssignments/${ASSIGNMENT}?`]: {
          id: ASSIGNMENT,
          principalId: TARGET,
          roleDefinitionId: GA,
        },
        '/roleManagement/directory/roleAssignments?': {
          value: [
            { id: ASSIGNMENT, principalId: TARGET },
            { id: 'group-assignment', principalId: GROUP },
          ],
        },
        [`/directoryObjects/${GROUP}`]: {
          '@odata.type': '#microsoft.graph.group',
          id: GROUP,
          isAssignableToRole: true,
        },
      });

      const result = await runGuardrails(
        'delete-role-assignment',
        { unifiedRoleAssignmentId: ASSIGNMENT },
        read
      );

      expect(result.blocked).toBe(false);
    });

    it('fails CLOSED when the assignment cannot be read', async () => {
      const read = reader({}, ['/roleManagement/directory/roleAssignments/']);

      const result = await runGuardrails(
        'delete-role-assignment',
        { unifiedRoleAssignmentId: ASSIGNMENT },
        read
      );

      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('anti-lockout check could not be completed');
      expect(result.reason).toContain('RoleManagement.Read.Directory');
    });

    it('fails CLOSED when the tenant Global Administrator list cannot be read', async () => {
      const read = reader(
        {
          [`/roleManagement/directory/roleAssignments/${ASSIGNMENT}?`]: {
            id: ASSIGNMENT,
            principalId: TARGET,
            roleDefinitionId: GA,
          },
        },
        ['/roleManagement/directory/roleAssignments?']
      );

      const result = await runGuardrails(
        'delete-role-assignment',
        { unifiedRoleAssignmentId: ASSIGNMENT },
        read
      );

      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('anti-lockout check could not be completed');
    });

    it('treats an unreadable co-holder as not surviving', async () => {
      const read = reader(
        {
          [`/roleManagement/directory/roleAssignments/${ASSIGNMENT}?`]: {
            id: ASSIGNMENT,
            principalId: TARGET,
            roleDefinitionId: GA,
          },
          '/roleManagement/directory/roleAssignments?': {
            value: [
              { id: ASSIGNMENT, principalId: TARGET },
              { id: 'other-assignment', principalId: OTHER },
            ],
          },
        },
        [`/directoryObjects/${OTHER}`]
      );

      const result = await runGuardrails(
        'delete-role-assignment',
        { unifiedRoleAssignmentId: ASSIGNMENT },
        read
      );

      expect(result.blocked).toBe(true);
    });

    it('passes on count alone beyond the probe cap', async () => {
      const many = Array.from({ length: 40 }, (_, i) => ({
        id: `assignment-${i}`,
        principalId: `principal-${i}`,
      }));
      const disabled: Record<string, unknown> = {};
      for (let i = 0; i < 40; i++) {
        disabled[`/directoryObjects/principal-${i}`] = {
          '@odata.type': '#microsoft.graph.user',
          id: `principal-${i}`,
          accountEnabled: false,
        };
      }

      const read = reader({
        [`/roleManagement/directory/roleAssignments/${ASSIGNMENT}?`]: {
          id: ASSIGNMENT,
          principalId: TARGET,
          roleDefinitionId: GA,
        },
        '/roleManagement/directory/roleAssignments?': {
          value: [{ id: ASSIGNMENT, principalId: TARGET }, ...many],
        },
        ...disabled,
      });

      const result = await runGuardrails(
        'delete-role-assignment',
        { unifiedRoleAssignmentId: ASSIGNMENT },
        read
      );

      expect(result.blocked).toBe(false);
      expect(result.notices[0]).toContain('40 Global Administrator assignments');
    });
  });

  describe('remove-directory-role-member', () => {
    it('ignores a non-Global-Administrator role', async () => {
      const read = reader({
        [`/directoryRoles/${ROLE}?`]: {
          id: ROLE,
          displayName: 'Reports Reader',
          roleTemplateId: '4a5d8f65-41da-4de4-8968-e035b65339cf',
        },
      });

      const result = await runGuardrails(
        'remove-directory-role-member',
        { directoryRoleId: ROLE, directoryObjectId: TARGET },
        read
      );

      expect(result.blocked).toBe(false);
      expect(read.calls.some((c) => c.includes('/members'))).toBe(false);
    });

    it('refuses when the target is the last enabled member', async () => {
      const read = reader({
        [`/directoryRoles/${ROLE}?`]: {
          id: ROLE,
          displayName: 'Global Administrator',
          roleTemplateId: GA,
        },
        [`/directoryRoles/${ROLE}/members`]: {
          value: [
            { '@odata.type': '#microsoft.graph.user', id: TARGET, accountEnabled: true },
            { '@odata.type': '#microsoft.graph.user', id: OTHER, accountEnabled: false },
          ],
        },
      });

      const result = await runGuardrails(
        'remove-directory-role-member',
        { directoryRoleId: ROLE, directoryObjectId: TARGET },
        read
      );

      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('last active Global Administrator');
    });

    it('allows when another enabled member remains', async () => {
      const read = reader({
        [`/directoryRoles/${ROLE}?`]: {
          id: ROLE,
          displayName: 'Global Administrator',
          roleTemplateId: GA,
        },
        [`/directoryRoles/${ROLE}/members`]: {
          value: [
            { '@odata.type': '#microsoft.graph.user', id: TARGET, accountEnabled: true },
            { '@odata.type': '#microsoft.graph.user', id: OTHER, accountEnabled: true },
          ],
        },
      });

      const result = await runGuardrails(
        'remove-directory-role-member',
        { directoryRoleId: ROLE, directoryObjectId: TARGET },
        read
      );

      expect(result.blocked).toBe(false);
    });

    it('fails CLOSED when the member list cannot be read', async () => {
      const read = reader(
        {
          [`/directoryRoles/${ROLE}?`]: {
            id: ROLE,
            displayName: 'Global Administrator',
            roleTemplateId: GA,
          },
        },
        [`/directoryRoles/${ROLE}/members`]
      );

      const result = await runGuardrails(
        'remove-directory-role-member',
        { directoryRoleId: ROLE, directoryObjectId: TARGET },
        read
      );

      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('anti-lockout check could not be completed');
    });
  });
});

describe('guardrail 5 — role-assignable group', () => {
  it('records the extra permission as an error hint, without blocking', async () => {
    const read = reader({
      [`/groups/${GROUP}?`]: { ...plainGroup, isAssignableToRole: true },
      [`/groups/${GROUP}/owners?`]: { value: [{ id: TARGET }, { id: OTHER }] },
    });

    const result = await runGuardrails(
      'remove-group-owner',
      { groupId: GROUP, directoryObjectId: TARGET },
      read
    );

    expect(result.blocked).toBe(false);
    expect(result.errorHints).toHaveLength(1);
    expect(result.errorHints[0]).toContain('RoleManagement.ReadWrite.Directory');
    expect(result.errorHints[0]).toContain('Test-Group');
  });

  it('adds no hint for an ordinary group', async () => {
    const read = reader({ [`/groups/${GROUP}?`]: plainGroup });

    const result = await runGuardrails(
      'remove-group-member',
      { groupId: GROUP, directoryObjectId: TARGET },
      read
    );

    expect(result.errorHints).toHaveLength(0);
  });
});

describe('fail-open posture on the group pre-flight', () => {
  it('proceeds with a notice when the group itself cannot be read', async () => {
    const read = reader({}, [`/groups/${GROUP}`]);

    const result = await runGuardrails(
      'remove-group-member',
      { groupId: GROUP, directoryObjectId: TARGET },
      read
    );

    expect(result.blocked).toBe(false);
    expect(result.notices[0]).toContain('checks were skipped');
  });

  it('skips the pre-flight entirely when no group id was supplied', async () => {
    const read = reader({});

    const result = await runGuardrails('remove-group-member', {}, read);

    expect(result.blocked).toBe(false);
    expect(read.calls).toHaveLength(0);
  });
});
