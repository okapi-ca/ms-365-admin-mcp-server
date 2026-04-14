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
