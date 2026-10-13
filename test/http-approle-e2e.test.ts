import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import endpoints from '../src/endpoints.json' with { type: 'json' };
import { effectiveRiskLevel, rank, type RiskLevel } from '../src/risk-level.js';
import type AuthManager from '../src/auth.js';

// Node 18 lacks the File global referenced by generated Zod schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!globalThis.File) (globalThis as any).File = Blob;

/**
 * SEC-G05 end to end: an HTTP caller's App Roles must reach registerGraphTools.
 *
 * graph-tools-role-filter.test.ts proves the filter works when it is handed a
 * tier set; it could not see that server.ts dropped the roles on the way in, so
 * every authenticated HTTP caller got every write. This suite drives the real
 * path instead: AdminGraphServer.start() → startHttpServer → auth middleware →
 * the createServer callback → registerGraphTools → tools/list over Streamable
 * HTTP. Only JWT signature checks, secrets and the listening port are stubbed.
 */

const { validateUserTokenExplainMock, validateEntraTokenExplainMock } = vi.hoisted(() => ({
  validateUserTokenExplainMock: vi.fn(),
  validateEntraTokenExplainMock: vi.fn(),
}));

vi.mock('../src/user-token-validator.js', () => ({
  validateUserTokenExplain: validateUserTokenExplainMock,
}));

vi.mock('../src/token-validator.js', () => ({
  validateEntraTokenExplain: validateEntraTokenExplainMock,
}));

vi.mock('../src/secrets.js', () => ({
  getSecrets: async () => ({
    clientId: '22222222-2222-2222-2222-222222222222',
    tenantId: '11111111-1111-1111-1111-111111111111',
    clientSecret: 'test-only',
    cloudType: 'global',
  }),
}));

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  enableConsoleLogging: vi.fn(),
}));

import AdminGraphServer from '../src/server.js';

// The bearer value selects the identity the stubbed validators return:
// `user:<roles>` authenticates on the OBO path, `svc:<roles>` on the
// service-to-service path. Roles are comma-separated, empty for none.
function rolesFromBearer(token: string): string[] {
  const raw = token.slice(token.indexOf(':') + 1);
  return raw ? raw.split(',') : [];
}

validateUserTokenExplainMock.mockImplementation(async (token: string) =>
  token.startsWith('user:')
    ? {
        ok: true,
        claims: {
          oid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          upn: 'alice@contoso.com',
          roles: rolesFromBearer(token),
        },
      }
    : { ok: false, reason: 'invalid_token' }
);

validateEntraTokenExplainMock.mockImplementation(async (token: string) =>
  token.startsWith('svc:')
    ? {
        ok: true,
        claims: { appid: '33333333-3333-3333-3333-333333333333', roles: rolesFromBearer(token) },
      }
    : { ok: false, reason: 'invalid_token' }
);

// startHttpServer() binds a fixed port and returns no handle. Rebind on an
// ephemeral loopback port and keep the server so the suite can reach and close it.
const listening: Server[] = [];
const originalListen = express.application.listen;
vi.spyOn(express.application, 'listen').mockImplementation(function (this: express.Application) {
  const server = originalListen.call(this, 0, '127.0.0.1') as Server;
  listening.push(server);
  return server;
});

async function startHttp(maxRiskLevel?: RiskLevel): Promise<string> {
  const admin = new AdminGraphServer({} as AuthManager, {
    transport: 'http',
    readOnly: false,
    maxRiskLevel,
    // OBO users and service principals side by side, users admitted by
    // Enterprise App assignment as in production.
    allowedClients: '33333333-3333-3333-3333-333333333333',
    oauthMode: true,
    publicUrl: 'https://mcp.example.com',
    authorizeByAppRole: true,
  });
  await admin.initialize('test');
  await admin.start();
  const server = listening[listening.length - 1];
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function listToolsOver(server: McpServer | string, bearer?: string): Promise<Set<string>> {
  const client = new Client({ name: 'sec-g04-e2e', version: '0.0.0' });
  if (typeof server === 'string') {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${server}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
      })
    );
  } else {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
  }
  const { tools } = await client.listTools();
  await client.close();
  return new Set(tools.map((t) => t.name));
}

interface Endpoint {
  toolName: string;
  method: string;
  riskLevel?: RiskLevel;
}

const writes = (endpoints as Endpoint[]).filter((e) => e.method.toUpperCase() !== 'GET');
const reads = (endpoints as Endpoint[]).filter((e) => e.method.toUpperCase() === 'GET');

/** Writes a caller should see, given its tiers and the server-wide cap. */
function expectedWrites(tiers: RiskLevel[], cap: RiskLevel = 'critical'): Set<string> {
  return new Set(
    writes
      .filter((e) => {
        const tier = effectiveRiskLevel(e.riskLevel, e.method);
        return tiers.includes(tier) && rank(tier) <= rank(cap);
      })
      .map((e) => e.toolName)
  );
}

function writesIn(tools: Set<string>): Set<string> {
  return new Set(writes.map((e) => e.toolName).filter((name) => tools.has(name)));
}

let uncappedUrl: string;
let highCapUrl: string;

beforeAll(async () => {
  uncappedUrl = await startHttp();
  highCapUrl = await startHttp('high');
}, 30_000);

afterAll(() => {
  for (const server of listening) server.close();
});

describe('SEC-G05 — App Roles reach the per-request tool registry over HTTP', () => {
  it('fixture sanity: every write tier is populated', () => {
    for (const tier of ['low', 'medium', 'high', 'critical'] as const) {
      expect(expectedWrites([tier]).size, tier).toBeGreaterThan(0);
    }
  });

  it('a user with no Tools.Write.* role sees every read and no write', async () => {
    const tools = await listToolsOver(uncappedUrl, 'user:');
    expect(writesIn(tools)).toEqual(new Set());
    for (const e of reads) expect(tools.has(e.toolName), e.toolName).toBe(true);
  });

  it('Tools.Read.All alone grants no write (declarative tag)', async () => {
    const tools = await listToolsOver(uncappedUrl, 'user:Tools.Read.All');
    expect(writesIn(tools)).toEqual(new Set());
  });

  it('Tools.Write.LowMedium grants exactly the low and medium writes', async () => {
    const tools = await listToolsOver(uncappedUrl, 'user:Tools.Write.LowMedium');
    expect(writesIn(tools)).toEqual(expectedWrites(['low', 'medium']));
  });

  it('Tools.Write.High grants exactly the high writes', async () => {
    const tools = await listToolsOver(uncappedUrl, 'user:Tools.Write.High');
    expect(writesIn(tools)).toEqual(expectedWrites(['high']));
  });

  it('Tools.Write.Critical grants exactly the critical writes (no implied lower tiers)', async () => {
    const tools = await listToolsOver(uncappedUrl, 'user:Tools.Write.Critical');
    expect(writesIn(tools)).toEqual(expectedWrites(['critical']));
  });

  it('roles are additive and need not be contiguous', async () => {
    const tools = await listToolsOver(
      uncappedUrl,
      'user:Tools.Write.LowMedium,Tools.Write.Critical'
    );
    expect(writesIn(tools)).toEqual(expectedWrites(['low', 'medium', 'critical']));
  });

  it('a service principal is filtered by its own roles claim, like a user', async () => {
    expect(writesIn(await listToolsOver(uncappedUrl, 'svc:'))).toEqual(new Set());
    expect(writesIn(await listToolsOver(uncappedUrl, 'svc:Tools.Write.High'))).toEqual(
      expectedWrites(['high'])
    );
  });

  it('--max-risk-level still caps a caller holding every write role', async () => {
    const tools = await listToolsOver(
      highCapUrl,
      'user:Tools.Write.LowMedium,Tools.Write.High,Tools.Write.Critical'
    );
    expect(writesIn(tools)).toEqual(expectedWrites(['low', 'medium', 'high'], 'high'));
  });

  it('--max-risk-level and the role filter compose in AND', async () => {
    const tools = await listToolsOver(highCapUrl, 'user:Tools.Write.Critical');
    expect(writesIn(tools)).toEqual(new Set());
  });
});

describe('SEC-G05 — stdio keeps its behavior (no caller identity, no role filter)', () => {
  it('registers every write that --allow-writes and the cap permit', async () => {
    const admin = new AdminGraphServer({} as AuthManager, { readOnly: false });
    await admin.initialize('test');
    const tools = await listToolsOver(admin.createServer());
    expect(writesIn(tools)).toEqual(expectedWrites(['low', 'medium', 'high', 'critical']));
  });

  it('still honors --max-risk-level', async () => {
    const admin = new AdminGraphServer({} as AuthManager, {
      readOnly: false,
      maxRiskLevel: 'medium',
    });
    await admin.initialize('test');
    const tools = await listToolsOver(admin.createServer());
    expect(writesIn(tools)).toEqual(expectedWrites(['low', 'medium'], 'medium'));
  });
});
