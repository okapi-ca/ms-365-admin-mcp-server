export interface ToolCategory {
  name: string;
  pattern: RegExp;
  description: string;
}

export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  security: {
    name: 'security',
    pattern: /security|alert|incident/i,
    description: 'Security alerts and incidents (Microsoft 365 Defender)',
  },
  audit: {
    name: 'audit',
    pattern: /audit|sign-in|provisioning|directory/i,
    description: 'Audit logs (directory audits, sign-ins, provisioning)',
  },
  health: {
    name: 'health',
    pattern: /service|health|issue|message/i,
    description: 'Service health and Message Center announcements',
  },
  reports: {
    name: 'reports',
    pattern: /report|activity|usage/i,
    description: 'Usage reports (Teams, Email, Active Users, SharePoint)',
  },
  identity: {
    name: 'identity',
    pattern:
      /user|group|role|conditional|directory|domain|auth-method|credential|application|service-principal|oauth2|organization|named-location/i,
    description: 'Identity and access management (Entra ID users, groups, roles, policies)',
  },
  compliance: {
    name: 'compliance',
    pattern:
      /secure-score|subscribed-sku|license|risky-user|risky-service|security-defaults|auth-method-config|admin-consent/i,
    description: 'Compliance, licenses, Secure Score, Identity Protection, and security policies',
  },
  intune: {
    name: 'intune',
    pattern: /managed-device|compliance-polic|device-configuration|detected-app/i,
    description: 'Intune device management (managed devices, compliance, configurations, apps)',
  },
  threatintel: {
    name: 'threatintel',
    pattern: /threat-intel|attack-simulation/i,
    description:
      'Threat intelligence (articles, profiles, hosts, vulnerabilities, attack simulations)',
  },
  collaboration: {
    name: 'collaboration',
    pattern: /sharepoint|team(?!s-activity)|cross-tenant|deleted-user|deleted-group/i,
    description: 'SharePoint, Teams, cross-tenant access, and deleted items',
  },
  response: {
    name: 'response',
    pattern:
      /disable-user|revoke|block|reset|isolate|update-security|delete-user-auth|update-device|update-user-auth/i,
    description: 'Incident response operations (disable user, revoke sessions, update alerts)',
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
