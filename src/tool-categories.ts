export interface ToolCategory {
  name: string;
  pattern: RegExp;
  description: string;
}

export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  security: {
    name: 'security',
    pattern: /security|alert|incident|attack-simulation|threat-intel/i,
    description:
      'Security alerts, incidents, attack simulations, and threat intelligence (Microsoft 365 Defender)',
  },
  audit: {
    name: 'audit',
    pattern: /audit|sign-in|provisioning|directory|deleted-user|deleted-group/i,
    description: 'Audit logs, deleted items (directory audits, sign-ins, provisioning)',
  },
  health: {
    name: 'health',
    pattern: /service|health|issue|message/i,
    description: 'Service health and Message Center announcements',
  },
  reports: {
    name: 'reports',
    pattern: /report|activity|usage/i,
    description:
      'Usage reports (Teams, Email, Active Users, SharePoint, OneDrive, Mailbox, M365 Apps)',
  },
  identity: {
    name: 'identity',
    pattern:
      /user|group|role|conditional|directory|domain|auth-method|credential|application|service-principal|sp-password|sp-key|sp-token|sp-owner|oauth2|organization|named-location|device|administrative-unit|cross-tenant|pim|app-role|invitation|identity-provider|b2x|api-connector|custom-auth/i,
    description:
      'Identity and access management (Entra ID users, groups, roles, devices, PIM, guest users, external identities)',
  },
  compliance: {
    name: 'compliance',
    pattern:
      /secure-score|subscribed-sku|license|risky-user|risky-service|risk-detection|security-defaults|auth-method-config|auth-strength|admin-consent|service-principal-risk|subject-rights|copilot|attribute-set|custom-security-attribute|device-local-credential|federation-config|on-premises-sync|user-registration-detail/i,
    description:
      'Compliance, licenses, Secure Score, Identity Protection, risk detections, security policies, Copilot admin, custom security attributes, LAPS, DSAR',
  },
  exchange: {
    name: 'exchange',
    pattern: /message-trace|exchange-mailbox|mailbox-usage|mailbox-folder|export-exchange/i,
    description: 'Exchange administration (message traces, mailboxes, folders, export)',
  },
  intune: {
    name: 'intune',
    pattern:
      /managed-device|compliance-policy|compliance-state|device-configuration|enrollment|autopilot|detected-app|device-overview|intune|software-update|apple-push|mtd-connector|ios-update|device-categor|compliance-management|device-management-partner|exchange-connector|remote-assistance|notification-message|resource-operation|imported-autopilot|malware|mobile-app|app-categor|app-configuration|managed-app|app-protection|wip-polic|vpp-token|targeted-app|wipe-managed|retire-managed|sync-managed|reboot-managed|remote-lock|reset-device|shutdown-managed|lost-mode|locate-managed|bypass-activation|defender-scan|defender-signature|clean-windows|shared-apple|windows-device-account/i,
    description:
      'Intune device management (managed devices, compliance, configurations, Autopilot, apps, MAM, RBAC, reports)',
  },
  governance: {
    name: 'governance',
    pattern:
      /access-review|access-package|entitlement|connected-org|lifecycle|pim-group|terms-of-use|app-consent|user-consent|pim-role|role-management-polic|role-resource-namespace/i,
    description:
      'Identity Governance (access reviews, entitlement management, lifecycle workflows, PIM for Groups/Roles, terms of use, app consent)',
  },
  response: {
    name: 'response',
    pattern:
      /disable-user|revoke|block|reset|isolate|update-security|delete-user-auth|delete-user-phone|update-device|update-user-auth|confirm-compromised|dismiss-risky|confirm-safe|hunting-query|wipe-managed|retire-managed|remote-lock|locate-managed|bypass-activation/i,
    description:
      'Incident response operations (disable user, revoke sessions, confirm compromised/safe, dismiss risk, hunting queries)',
  },
  ediscovery: {
    name: 'ediscovery',
    pattern: /ediscovery/i,
    description: 'eDiscovery cases (Microsoft Purview)',
  },
  cloudpc: {
    name: 'cloudpc',
    pattern: /cloud-pc|provisioning-polic/i,
    description:
      'Cloud PC / Windows 365 (cloud PCs, provisioning policies, device images, gallery images, network connections, user settings, audit events)',
  },
  callrecords: {
    name: 'callrecords',
    pattern: /call-record|call-session|pstn-call|direct-routing/i,
    description:
      'Teams call records (sessions, segments, participants, PSTN calls, Direct Routing)',
  },
  print: {
    name: 'print',
    pattern: /print/i,
    description:
      'Universal Print (printers, shares, connectors, services, operations, task definitions)',
  },
  infoprotection: {
    name: 'infoprotection',
    pattern:
      /bitlocker|threat-assessment|recovery-key|sensitivity-label|sensitivity-sublabel|protection-scope/i,
    description:
      'Information Protection (BitLocker recovery keys, threat assessment requests, sensitivity labels)',
  },
  sharepointadmin: {
    name: 'sharepointadmin',
    pattern:
      /sharepoint-setting|sharepoint-site|site-drive|site-list|site-column|site-content-type|site-permission|site-analytic|site-subsite/i,
    description:
      'SharePoint administration (tenant settings, sites, drives, lists, columns, content types, permissions, analytics)',
  },
  retention: {
    name: 'retention',
    pattern: /retention-label|file-plan/i,
    description:
      'Records Management (retention labels, file plan authorities, categories, citations, departments, references)',
  },
  teamsadmin: {
    name: 'teamsadmin',
    pattern:
      /list-teams$|get-team$|create-team$|update-team$|delete-team$|team-admin|team-installed|archive-team|unarchive-team|clone-team|team-operation|team-permission|teams-app|teams-catalog|deleted-team|teams-user-config|teams-admin|teams-policy|teams-phone/i,
    description:
      'Teams administration (teams, channels, members, apps, archive/clone, policies, phone assignments)',
  },
  all: {
    name: 'all',
    pattern: /.*/,
    description: 'All available admin tools',
  },
};

export function getCombinedPresetPattern(presets: string[]): string {
  const patterns = presets.map((preset) => {
    const category = TOOL_CATEGORIES[preset];
    if (!category) {
      throw new Error(
        `Unknown preset: ${preset}. Available presets: ${Object.keys(TOOL_CATEGORIES).join(', ')}`
      );
    }
    return category.pattern.source;
  });
  return patterns.join('|');
}

export function listPresets(): Array<{ name: string; description: string }> {
  return Object.values(TOOL_CATEGORIES).map((category) => ({
    name: category.name,
    description: category.description,
  }));
}
