import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGraphTools } from '../src/graph-tools.js';
import type { RiskLevel } from '../src/risk-level.js';
import type GraphClient from '../src/graph-client.js';

// Node 18 lacks the File global referenced by generated Zod schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!globalThis.File) (globalThis as any).File = Blob;

/**
 * Integration tests for per-caller write tier filtering in
 * registerGraphTools(). We mock just enough of McpServer to capture which
 * tool aliases are registered for each (readOnly, maxRiskLevel, writeRiskTiers)
 * combination — the executeGraphTool callback is never invoked.
 */

interface CapturedTool {
  alias: string;
}

function makeMockServer(): { server: McpServer; tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  // We only need `tool()` — the rest of McpServer is never reached.
  const server = {
    tool: (
      alias: string,
      _description: string,
      _paramSchema: unknown,
      _meta: unknown,
      _handler: unknown
    ) => {
      tools.push({ alias });
    },
  } as unknown as McpServer;
  return { server, tools };
}

const mockGraphClient = {} as GraphClient;

// Representative writes hand-picked from endpoints.json so each tier has at
// least one fixture. If these endpoints ever change tier, the test fails loudly.
const REPRESENTATIVES = {
  low: 'add-security-alert-comment',
  medium: 'update-security-alert',
  high: 'revoke-user-sessions',
  critical: 'disable-user-account',
} as const;

function registerWith(
  opts: {
    readOnly?: boolean;
    maxRiskLevel?: RiskLevel;
    writeRiskTiers?: Set<RiskLevel>;
  } = {}
): Set<string> {
  const { server, tools } = makeMockServer();
  registerGraphTools(
    server,
    mockGraphClient,
    opts.readOnly ?? false,
    undefined,
    opts.maxRiskLevel ?? 'critical',
    undefined,
    opts.writeRiskTiers
  );
  return new Set(tools.map((t) => t.alias));
}

describe('registerGraphTools — per-caller write tier filter', () => {
  it('writeRiskTiers undefined → behaves as before (every tier registered)', () => {
    // stdio path: no caller identity, no per-caller filter. All four
    // representative writes must be registered.
    const registered = registerWith({ writeRiskTiers: undefined });
    for (const alias of Object.values(REPRESENTATIVES)) {
      expect(registered.has(alias)).toBe(true);
    }
  });

  it('writeRiskTiers empty Set → caller is read-only (no writes registered)', () => {
    // Authenticated caller, no Tools.Write.* role.
    const registered = registerWith({ writeRiskTiers: new Set() });
    for (const alias of Object.values(REPRESENTATIVES)) {
      expect(registered.has(alias)).toBe(false);
    }
    // Reads are still registered — pick a known GET endpoint.
    expect(registered.has('list-security-alerts')).toBe(true);
  });

  it('Tools.Write.LowMedium → low + medium writes only', () => {
    const registered = registerWith({ writeRiskTiers: new Set(['low', 'medium']) });
    expect(registered.has(REPRESENTATIVES.low)).toBe(true);
    expect(registered.has(REPRESENTATIVES.medium)).toBe(true);
    expect(registered.has(REPRESENTATIVES.high)).toBe(false);
    expect(registered.has(REPRESENTATIVES.critical)).toBe(false);
  });

  it('Tools.Write.High alone → only high writes', () => {
    const registered = registerWith({ writeRiskTiers: new Set(['high']) });
    expect(registered.has(REPRESENTATIVES.low)).toBe(false);
    expect(registered.has(REPRESENTATIVES.medium)).toBe(false);
    expect(registered.has(REPRESENTATIVES.high)).toBe(true);
    expect(registered.has(REPRESENTATIVES.critical)).toBe(false);
  });

  it('Tools.Write.Critical alone → only critical writes', () => {
    const registered = registerWith({ writeRiskTiers: new Set(['critical']) });
    expect(registered.has(REPRESENTATIVES.low)).toBe(false);
    expect(registered.has(REPRESENTATIVES.medium)).toBe(false);
    expect(registered.has(REPRESENTATIVES.high)).toBe(false);
    expect(registered.has(REPRESENTATIVES.critical)).toBe(true);
  });

  it('Combinations are additive (LowMedium + Critical, no High)', () => {
    // Validates that the three roles are independent, not a hierarchy.
    const registered = registerWith({
      writeRiskTiers: new Set(['low', 'medium', 'critical']),
    });
    expect(registered.has(REPRESENTATIVES.low)).toBe(true);
    expect(registered.has(REPRESENTATIVES.medium)).toBe(true);
    expect(registered.has(REPRESENTATIVES.high)).toBe(false);
    expect(registered.has(REPRESENTATIVES.critical)).toBe(true);
  });

  it('composes in AND with --max-risk-level (server cap excludes critical even with the role)', () => {
    // Server started with --max-risk-level=high. A caller with
    // Tools.Write.Critical assigned still cannot reach critical writes
    // because the server itself never registers them.
    const registered = registerWith({
      maxRiskLevel: 'high',
      writeRiskTiers: new Set(['critical', 'high']),
    });
    expect(registered.has(REPRESENTATIVES.critical)).toBe(false);
    expect(registered.has(REPRESENTATIVES.high)).toBe(true);
  });

  it('composes in AND with --allow-writes (readOnly=true wins over any role)', () => {
    // The kill switch: even with every role granted, readOnly=true means
    // no writes are registered for any caller.
    const registered = registerWith({
      readOnly: true,
      writeRiskTiers: new Set(['low', 'medium', 'high', 'critical']),
    });
    for (const alias of Object.values(REPRESENTATIVES)) {
      expect(registered.has(alias)).toBe(false);
    }
  });
});
