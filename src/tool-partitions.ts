/**
 * Partitions of the tool catalog, each group served as its own MCP endpoint
 * (`/mcp/<group>`) next to the full catalog at `/mcp`. See "Per-domain
 * endpoints" in docs/HTTP_DEPLOYMENT.md.
 *
 * A partition is data: group → README inventory sections, plus the few tools
 * moved out of their section by name. Every endpoint in endpoints.json carries
 * its README `section`, so changing the grouping means editing a table here —
 * the routing and registration code never names a group.
 *
 * Unlike the presets in tool-categories.ts, which overlap and leave tools out,
 * each table must place every tool in exactly one group. `resolvePartition`
 * enforces that at startup and test/tool-partitions.test.ts pins it for every
 * table, along with a schema-size ceiling per group.
 */

export interface ToolGroup {
  /** README inventory sections (`### Title`, without the count) whose tools land here. */
  readonly sections: readonly string[];
  /** Tools pulled in by name from a section owned by another group. */
  readonly tools?: readonly string[];
}

export interface ToolPartition {
  readonly description: string;
  readonly groups: Readonly<Record<string, ToolGroup>>;
}

// Tools are placed by the Entra built-in role an administrator needs to use
// them, not by the scenario they serve (HTTP_DEPLOYMENT.md, "Placement rule"). Most README
// sections are homogeneous in that respect and move as a whole; the tools
// listed by name below are the exceptions, each with the role that places it.

const ENTRA_SECTIONS = [
  'Users',
  'Devices',
  'Groups',
  'Directory roles & PIM',
  'Administrative units',
  'Conditional access',
  'Conditional Access CRUD',
  'Applications & app roles',
  'App credentials & owners',
  'Application credentials & owners CRUD',
  'Service Principals CRUD & credentials',
  'App management policies',
  'App consent requests',
  'Security & access policies',
  'Advanced policies',
  'Guest user invitations',
  'External identity providers',
  'Self-service sign-up',
  'Custom authentication extensions',
  'Access reviews',
  'Access Reviews CRUD & actions',
  'Entitlement management',
  'Entitlement Management CRUD',
  'Lifecycle workflows',
  'Lifecycle Workflows CRUD & execution',
  'PIM for Groups',
  'PIM role management',
  'PIM activation & requests',
  'Terms of use',
  'Identity Governance+',
  'Directory+',
] as const;

/**
 * Tenant-wide administration, held by tenant roles (License, Domain Name,
 * Service Support, AI, Reports Reader) that belong to no workload domain.
 * Usage reports are tenant-wide too, minus the per-workload ones moved below.
 */
const TENANT_SECTIONS = [
  'Organization & domains',
  'Licenses',
  'Service health',
  'Copilot admin',
  'Usage reports',
] as const;

const DEVICE_SECTIONS = [
  'Managed devices',
  'Compliance policies',
  'Device configurations',
  'Device categories',
  'macOS Platform Scripts',
  'macOS custom attribute shell scripts',
  'Windows PowerShell scripts (deviceManagementScripts)',
  'Windows custom compliance scripts (deviceComplianceScripts)',
  'Intune Remediations / Proactive Remediations',
  'Assignment filters',
  'Enrollment & Autopilot',
  'Detected apps',
  'Intune RBAC & config',
  'Intune connectors & updates',
  'Intune device remote actions',
  'Intune policies CRUD',
  'Intune reports',
  'Intune partners & infrastructure',
  'Intune app management',
  'Cloud PC / Windows 365',
  'Universal Print',
  // Print usage reports, plus the MFA registration report moved to identity below.
  'Reports+',
] as const;

const DEFENDER_SECTIONS = [
  'Security',
  'Secure Score',
  'Security advanced',
  'Defender for Identity',
  'Threat intelligence - hosts',
  'Threat intelligence - articles & profiles',
  'Threat intelligence - vulnerabilities & WHOIS',
  'Threat intelligence - infrastructure',
  'Threat intelligence+',
  // Identity Protection is administered by Security Administrator / Operator.
  'Identity Protection & risk detections',
  'Identity Protection+',
  // Entra audit and sign-in logs: Security Reader. The two deleted-item reads
  // in this section are moved to identity below.
  'Audit logs & deleted items',
  // Risk confirmations and hunting stay here; the user, device and auth-method
  // actions are moved to identity below.
  'Incident response',
] as const;

const PURVIEW_SECTIONS = [
  'eDiscovery (Purview)',
  'Records Management',
  'Information Protection & Sensitivity Labels',
  'Purview DSPM (protection scopes)',
] as const;

const EXCHANGE_SECTIONS = ['Exchange message traces', 'Exchange mailboxes'] as const;

const SHAREPOINT_SECTIONS = [
  'SharePoint administration',
  'OneDrive / user drive (DSAR enumeration)',
] as const;

const TEAMS_SECTIONS = [
  'Teams administration',
  'Teams call records',
  'Teams online meeting attendance',
  'Teams chat investigation reads',
  'Teams deleted chats',
] as const;

/** Moved to identity: each needs an Entra directory role, not the role its section implies. */
const IDENTITY_MOVES = [
  // Incident response actions on users and devices.
  'disable-user-account', // User Administrator
  'revoke-user-sessions', // User Administrator
  'update-device', // Cloud Device Administrator (Entra device object)
  'delete-user-phone-auth-method', // Authentication Administrator, for all seven
  'delete-user-fido2-auth-method',
  'delete-user-authenticator-auth-method',
  'delete-user-software-oath-auth-method',
  'delete-user-windows-hello-auth-method',
  'delete-user-email-auth-method',
  'delete-user-temporary-access-pass-auth-method',
  // Directory recycle bin, not an audit log: User / Groups Administrator.
  'list-deleted-users',
  'list-deleted-groups',
  // MFA registration report, not print usage: Reports Reader / Authentication Administrator.
  'list-user-registration-details',
] as const;

/** Moved to intune: device recovery secrets, read by Intune Administrator. */
const INTUNE_MOVES = [
  'list-bitlocker-recovery-keys', // listed under Information Protection for its Graph path
  'list-device-local-credentials', // Windows LAPS, listed under Directory+
] as const;

const EXCHANGE_REPORTS = ['get-email-activity-report', 'get-mailbox-usage-report'] as const;
const SHAREPOINT_REPORTS = ['get-sharepoint-usage-report', 'get-onedrive-usage-report'] as const;
const TEAMS_REPORTS = ['get-teams-activity-report'] as const;

export const PARTITIONS = {
  /** Option A: one domain per Microsoft 365 service, aligned with Entra admin roles. */
  domains: {
    description:
      'One endpoint per Microsoft 365 service, aligned with Entra built-in admin roles (option A, default)',
    groups: {
      identity: { sections: [...ENTRA_SECTIONS, ...TENANT_SECTIONS], tools: IDENTITY_MOVES },
      intune: { sections: DEVICE_SECTIONS, tools: INTUNE_MOVES },
      security: {
        sections: DEFENDER_SECTIONS,
        tools: ['list-threat-assessment-requests'], // Defender submission flow: Security Operator
      },
      purview: {
        sections: PURVIEW_SECTIONS,
        // "Security advanced" mixes attack simulation with records and DSAR: Compliance Administrator.
        tools: [
          'list-retention-events',
          'list-retention-event-types',
          'list-subject-rights-requests',
        ],
      },
      exchange: { sections: EXCHANGE_SECTIONS, tools: EXCHANGE_REPORTS },
      sharepoint: { sections: SHAREPOINT_SECTIONS, tools: SHAREPOINT_REPORTS },
      teams: { sections: TEAMS_SECTIONS, tools: TEAMS_REPORTS },
    },
  },
  /**
   * Option B: four groups, each a union of option A domains (identity; intune;
   * security + purview; exchange + sharepoint + teams).
   */
  groups: {
    description: 'Four endpoints, each a union of option A domains (option B)',
    groups: {
      identity: { sections: [...ENTRA_SECTIONS, ...TENANT_SECTIONS], tools: IDENTITY_MOVES },
      devices: { sections: DEVICE_SECTIONS, tools: INTUNE_MOVES },
      security: { sections: [...DEFENDER_SECTIONS, ...PURVIEW_SECTIONS] },
      collaboration: {
        sections: [...EXCHANGE_SECTIONS, ...SHAREPOINT_SECTIONS, ...TEAMS_SECTIONS],
        tools: [...EXCHANGE_REPORTS, ...SHAREPOINT_REPORTS, ...TEAMS_REPORTS],
      },
    },
  },
} as const satisfies Record<string, ToolPartition>;

export type PartitionName = keyof typeof PARTITIONS;

/** The default partition; `--partition` overrides it. */
export const DEFAULT_PARTITION: PartitionName = 'domains';

export function isPartitionName(x: unknown): x is PartitionName {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(PARTITIONS, x);
}

/**
 * Maps every tool to its group, or throws naming every tool and section that is
 * unplaced, placed twice, or referenced but unknown. Called at startup, so a
 * table that is not a partition stops the server instead of silently dropping
 * or duplicating tools.
 */
export function resolvePartition(
  partition: ToolPartition,
  endpoints: readonly { toolName: string; section: string }[]
): Map<string, string> {
  const sectionGroup = new Map<string, string>();
  const movedTo = new Map<string, string>();
  const problems: string[] = [];
  const knownSections = new Set(endpoints.map((e) => e.section));
  const knownTools = new Set(endpoints.map((e) => e.toolName));

  for (const [group, def] of Object.entries(partition.groups)) {
    for (const section of def.sections) {
      const owner = sectionGroup.get(section);
      if (owner) problems.push(`section "${section}" is in both ${owner} and ${group}`);
      else if (!knownSections.has(section))
        problems.push(`section "${section}" (${group}) has no tools`);
      sectionGroup.set(section, group);
    }
    for (const tool of def.tools ?? []) {
      const owner = movedTo.get(tool);
      if (owner) problems.push(`tool ${tool} is moved to both ${owner} and ${group}`);
      else if (!knownTools.has(tool)) problems.push(`tool ${tool} (${group}) does not exist`);
      movedTo.set(tool, group);
    }
  }

  const toolGroup = new Map<string, string>();
  for (const { toolName, section } of endpoints) {
    const home = sectionGroup.get(section);
    const moved = movedTo.get(toolName);
    if (moved && moved === home) {
      problems.push(`tool ${toolName} is moved to ${moved}, which already owns its section`);
    }
    const group = moved ?? home;
    if (group === undefined) problems.push(`section "${section}" (${toolName}) is in no group`);
    else toolGroup.set(toolName, group);
  }

  if (problems.length > 0) {
    throw new Error(`Tool partition is not a partition:\n  ${problems.join('\n  ')}`);
  }
  return toolGroup;
}

/** Tool names served by each group, in a form the registration filter consumes. */
export function groupToolSets(toolGroup: Map<string, string>): Map<string, ReadonlySet<string>> {
  const sets = new Map<string, Set<string>>();
  for (const [tool, group] of toolGroup) {
    const set = sets.get(group) ?? new Set<string>();
    set.add(tool);
    sets.set(group, set);
  }
  return sets;
}
