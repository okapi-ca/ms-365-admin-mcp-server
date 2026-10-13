import { describe, it, expect, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import endpoints from '../src/endpoints.json' with { type: 'json' };
import { effectiveRiskLevel, type RiskLevel } from '../src/risk-level.js';
import type AuthManager from '../src/auth.js';

// Node 18 lacks the File global referenced by generated Zod schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!globalThis.File) (globalThis as any).File = Blob;

/**
 * Per-domain endpoints end to end: a `/mcp/<domain>` endpoint only narrows what `/mcp`
 * shows the same caller, and the caller's App Roles (SEC-G05) reach every
 * domain route.
 *
 * tool-partitions.test.ts and mcp-group-routes.test.ts check the tables and
 * the routing with a stub createServer, so they cannot see the callback in
 * server.ts. This suite drives the real path, as http-approle-e2e.test.ts does
 * for `/mcp`: AdminGraphServer.start() → startHttpServer → auth middleware →
 * the createServer callback → registerGraphTools → tools/list over Streamable
 * HTTP. If the callback drops the roles on a domain route, a
 * `Tools.Write.LowMedium` caller sees high and critical writes there and this
 * suite fails. Only JWT signature checks, secrets and the listening port are
 * stubbed.
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
import { endpointSections } from '../src/graph-tools.js';
import {
  PARTITIONS,
  groupToolSets,
  resolvePartition,
  type PartitionName,
} from '../src/tool-partitions.js';

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
// Each test starts its own server: one listing costs several requests, and a
// test walking every group would exceed the 100 req/min limiter of one app.
const listening: Server[] = [];
const originalListen = express.application.listen;
vi.spyOn(express.application, 'listen').mockImplementation(function (this: express.Application) {
  const server = originalListen.call(this, 0, '127.0.0.1') as Server;
  listening.push(server);
  return server;
});

async function startHttp(partition: PartitionName): Promise<string> {
  const admin = new AdminGraphServer({} as AuthManager, {
    transport: 'http',
    readOnly: false,
    partition,
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

async function listToolsAt(url: string, bearer: string): Promise<Set<string>> {
  const client = new Client({ name: 'domain-endpoints-e2e', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    })
  );
  const { tools } = await client.listTools();
  await client.close();
  return new Set(tools.map((t) => t.name));
}

interface Endpoint {
  toolName: string;
  method: string;
  riskLevel?: RiskLevel;
}

const writeTier = new Map(
  (endpoints as Endpoint[])
    .filter((e) => e.method.toUpperCase() !== 'GET')
    .map((e) => [e.toolName, effectiveRiskLevel(e.riskLevel, e.method)])
);

function writesIn(tools: Set<string>, tiers: RiskLevel[]): string[] {
  return [...tools].filter((name) => tiers.includes(writeTier.get(name) as RiskLevel)).sort();
}

const intersect = (a: Set<string>, b: ReadonlySet<string>): Set<string> =>
  new Set([...a].filter((x) => b.has(x)));

// Callers whose catalogs differ: no write role, each write role alone, all of
// them, and a service principal (the other auth path).
const BEARERS = [
  'user:',
  'user:Tools.Write.LowMedium',
  'user:Tools.Write.High',
  'user:Tools.Write.Critical',
  'user:Tools.Write.LowMedium,Tools.Write.High,Tools.Write.Critical',
  'svc:Tools.Write.LowMedium',
];

const PARTITION_NAMES = Object.keys(PARTITIONS) as PartitionName[];

const groupsOf = (name: PartitionName) =>
  groupToolSets(resolvePartition(PARTITIONS[name], endpointSections()));

afterAll(() => {
  for (const server of listening) server.close();
});

describe.each(PARTITION_NAMES)(
  'per-domain endpoints — /mcp/<group> over HTTP (partition "%s")',
  (name) => {
    it('fixture sanity: low/medium and high/critical writes span several groups', () => {
      const groups = groupsOf(name);
      const holding = (tiers: RiskLevel[]) =>
        [...groups.values()].filter((tools) =>
          [...tools].some((t) => tiers.includes(writeTier.get(t) as RiskLevel))
        ).length;
      expect(holding(['low', 'medium'])).toBeGreaterThan(1);
      expect(holding(['high', 'critical'])).toBeGreaterThan(1);
    });

    it('Tools.Write.LowMedium sees no high or critical write on any group', async () => {
      const url = await startHttp(name);
      for (const [group, groupTools] of groupsOf(name)) {
        const tools = await listToolsAt(`${url}/mcp/${group}`, 'user:Tools.Write.LowMedium');
        expect(writesIn(tools, ['high', 'critical']), group).toEqual([]);
        // Not an empty catalog by accident: the caller's own tiers still show.
        const ownWrites = [...groupTools].filter((t) =>
          ['low', 'medium'].includes(writeTier.get(t) as string)
        );
        expect(writesIn(tools, ['low', 'medium']), group).toEqual(ownWrites.sort());
      }
    }, 30_000);

    it.each(BEARERS)(
      'a group shows exactly what /mcp shows the same caller, narrowed to the group (%s)',
      async (bearer) => {
        const url = await startHttp(name);
        const full = await listToolsAt(`${url}/mcp`, bearer);
        const union = new Set<string>();
        for (const [group, groupTools] of groupsOf(name)) {
          const tools = await listToolsAt(`${url}/mcp/${group}`, bearer);
          const extra = [...tools].filter((t) => !full.has(t));
          expect(extra, `${group} shows tools absent from /mcp`).toEqual([]);
          expect(tools, group).toEqual(intersect(full, groupTools));
          for (const t of tools) union.add(t);
        }
        // The groups partition the catalog: together they give back /mcp.
        expect(union).toEqual(full);
      },
      30_000
    );
  }
);
