import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// Node 18 lacks the File global that the generated Zod schemas reference.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!globalThis.File) (globalThis as any).File = Blob;

const { api } = await import('../src/generated/client.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Endpoint {
  toolName: string;
  pathPattern: string;
  method: string;
  appPermissions?: string[];
  scopes?: string[];
  workScopes?: string[];
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
}

const endpoints: Endpoint[] = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'src', 'endpoints.json'), 'utf8')
);

describe('endpoints.json validation', () => {
  it('should use appPermissions only (no scopes or workScopes)', () => {
    const violations = endpoints.filter((e) => e.scopes || e.workScopes);

    if (violations.length > 0) {
      const details = violations
        .map(
          (e) =>
            `  ${e.toolName}: has ${e.scopes ? 'scopes' : ''}${e.workScopes ? 'workScopes' : ''}`
        )
        .join('\n');
      expect.fail(
        `${violations.length} endpoint(s) use scopes or workScopes instead of appPermissions. ` +
          `This admin server uses application permissions only.\n${details}`
      );
    }
  });

  it('should have appPermissions on every endpoint', () => {
    const missing = endpoints.filter((e) => !e.appPermissions || e.appPermissions.length === 0);

    if (missing.length > 0) {
      const details = missing.map((e) => `  ${e.toolName}`).join('\n');
      expect.fail(`${missing.length} endpoint(s) are missing appPermissions.\n${details}`);
    }
  });

  it('should have a riskLevel on every write endpoint', () => {
    // Per-caller write gating (App Roles → Tools.Write.LowMedium / High / Critical)
    // filters writes by their `riskLevel`. A write without riskLevel falls back
    // to `critical` via effectiveRiskLevel(), which is fail-safe — but the
    // intent is that every write be classified explicitly. This guard makes
    // adding a write without a tier a build failure rather than silent surprise.
    const writes = endpoints.filter((e) => e.method.toLowerCase() !== 'get');
    const unclassified = writes.filter((e) => !e.riskLevel);

    if (unclassified.length > 0) {
      const details = unclassified
        .map((e) => `  ${e.toolName} (${e.method.toUpperCase()} ${e.pathPattern})`)
        .join('\n');
      expect.fail(
        `${unclassified.length} write endpoint(s) missing riskLevel. ` +
          `Set "riskLevel": "low" | "medium" | "high" | "critical" — low for reversible/benign mutations, ` +
          `critical for destructive or irrevocable operations.\n${details}`
      );
    }
  });

  it('should have a matching generated client endpoint for every entry', () => {
    const generatedTools = new Set(api.endpoints.map((e) => e.alias));
    const orphans = endpoints.filter((e) => !generatedTools.has(e.toolName));

    if (orphans.length > 0) {
      const details = orphans
        .map((e) => `  ${e.toolName} (${e.method.toUpperCase()} ${e.pathPattern})`)
        .join('\n');
      expect.fail(
        `${orphans.length} endpoint(s) in endpoints.json have no matching generated client entry. ` +
          `Run npm run generate, or check that the path and method exist in the OpenAPI spec.\n${details}`
      );
    }
  });
});
