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
      /user|group|role|conditional|directory|domain|auth-method|credential|application|service-principal|oauth2|organization|named-location|device|administrative-unit|cross-tenant|pim|app-role|invitation|identity-provider|b2x|api-connector|custom-auth/i,
    description:
      'Identity and access management (Entra ID users, groups, roles, devices, PIM, guest users, external identities)',
  },
  compliance: {
    name: 'compliance',
    pattern:
      /secure-score|subscribed-sku|license|risky-user|risky-service|risk-detection|security-defaults|auth-method-config|auth-strength|admin-consent/i,
    description:
      'Compliance, licenses, Secure Score, Identity Protection, risk detections, and security policies',
  },
  exchange: {
    name: 'exchange',
    pattern: /message-trace|exchange-mailbox|mailbox-usage/i,
    description: 'Exchange administration (message traces, mailboxes)',
  },
  intune: {
    name: 'intune',
    pattern:
      /managed-device|compliance-policy|compliance-state|device-configuration|enrollment|autopilot|detected-app|device-overview|intune|software-update|apple-push|mtd-connector|ios-update|device-categor/i,
    description:
      'Intune device management (managed devices, compliance, configurations, Autopilot, apps, RBAC)',
  },
  governance: {
    name: 'governance',
    pattern:
      /access-review|access-package|entitlement|connected-org|lifecycle|pim-group|terms-of-use|app-consent|user-consent/i,
    description:
      'Identity Governance (access reviews, entitlement management, lifecycle workflows, PIM for Groups, terms of use, app consent)',
  },
  response: {
    name: 'response',
    pattern:
      /disable-user|revoke|block|reset|isolate|update-security|delete-user-auth|delete-user-phone|update-device|update-user-auth|confirm-compromised|dismiss-risky/i,
    description:
      'Incident response operations (disable user, revoke sessions, confirm compromised, dismiss risk, update alerts)',
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
    pattern: /call-record/i,
    description: 'Teams call records',
  },
  print: {
    name: 'print',
    pattern: /print/i,
    description:
      'Universal Print (printers, shares, connectors, services, operations, task definitions)',
  },
  infoprotection: {
    name: 'infoprotection',
    pattern: /bitlocker|threat-assessment|recovery-key/i,
    description: 'Information Protection (BitLocker recovery keys, threat assessment requests)',
  },
  sharepointadmin: {
    name: 'sharepointadmin',
    pattern: /sharepoint-setting/i,
    description: 'SharePoint tenant administration settings',
  },
  retention: {
    name: 'retention',
    pattern: /retention-label|file-plan/i,
    description:
      'Records Management (retention labels, file plan authorities, categories, citations, departments, references)',
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
