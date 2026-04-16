export interface ToolCategory {
  name: string;
  pattern: RegExp;
  description: string;
}

export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  security: {
    name: 'security',
    pattern: /security|alert|incident|attack-simulation/i,
    description: 'Security alerts, incidents, and attack simulations (Microsoft 365 Defender)',
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
    description: 'Usage reports (Teams, Email, Active Users, SharePoint, OneDrive, Mailbox, M365 Apps)',
  },
  identity: {
    name: 'identity',
    pattern:
      /user|group|role|conditional|directory|domain|auth-method|credential|application|service-principal|oauth2|organization|named-location|device|administrative-unit|cross-tenant|pim|app-role/i,
    description: 'Identity and access management (Entra ID users, groups, roles, devices, PIM, policies)',
  },
  compliance: {
    name: 'compliance',
    pattern:
      /secure-score|subscribed-sku|license|risky-user|risky-service|risk-detection|security-defaults|auth-method-config|auth-strength|admin-consent/i,
    description: 'Compliance, licenses, Secure Score, Identity Protection, risk detections, and security policies',
  },
  response: {
    name: 'response',
    pattern:
      /disable-user|revoke|block|reset|isolate|update-security|delete-user-auth|delete-user-phone|update-device|update-user-auth|confirm-compromised|dismiss-risky/i,
    description: 'Incident response operations (disable user, revoke sessions, confirm compromised, dismiss risk, update alerts)',
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
