import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Same validator stubs as http-server.test.ts: this suite checks routing and the
// order of middleware, not JWT verification.
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

import { createMcpAuthMiddleware, registerMcpRoutes } from '../src/http-server.js';
import { endpointSections, registerGraphTools } from '../src/graph-tools.js';
import {
  DEFAULT_PARTITION,
  PARTITIONS,
  groupToolSets,
  resolvePartition,
} from '../src/tool-partitions.js';
import type GraphClient from '../src/graph-client.js';

// Node 18 lacks the File global referenced by generated Zod schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!globalThis.File) (globalThis as any).File = Blob;

const toolGroup = resolvePartition(PARTITIONS[DEFAULT_PARTITION], endpointSections());
const groups = groupToolSets(toolGroup);
const groupNames = [...groups.keys()];

interface CreateServerCall {
  userToken?: string;
  roles?: string[];
  group?: string;
}

let url = '';
let server: Server;
const calls: CreateServerCall[] = [];

beforeAll(async () => {
  validateUserTokenExplainMock.mockImplementation(async (token: string) =>
    token === 'good'
      ? {
          ok: true,
          claims: { oid: 'oid-1', upn: 'alice@contoso.com', roles: ['Tools.Write.High'] },
        }
      : { ok: false, reason: 'invalid_token' }
  );

  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(
    '/mcp',
    createMcpAuthMiddleware({
      userValidator: {
        tenantId: '11111111-1111-1111-1111-111111111111',
        expectedAudiences: ['22222222-2222-2222-2222-222222222222'],
        authorizedUserOids: [],
        allowAnyTenantUser: true,
        requiredScopes: ['access_as_user'],
      },
    })
  );
  registerMcpRoutes(
    app,
    (userToken, roles, group) => {
      calls.push({ userToken, roles, group });
      const mcp = new McpServer({ name: 'probe', version: '0' });
      registerGraphTools(
        mcp,
        {} as GraphClient,
        false,
        undefined,
        'critical',
        undefined,
        undefined,
        group === undefined ? undefined : { name: group, tools: groups.get(group)! }
      );
      return mcp;
    },
    groupNames
  );

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') url = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(pathName: string, token = 'good'): Promise<Response> {
  return fetch(`${url}${pathName}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

async function listToolNames(pathName: string): Promise<string[]> {
  const res = await post(pathName);
  expect(res.status).toBe(200);
  const text = await res.text();
  // The stateless transport answers over SSE: one `data:` line per message.
  const data = text
    .split('\n')
    .find((l) => l.startsWith('data: '))
    ?.slice(6);
  const message = JSON.parse(data ?? text) as { result: { tools: { name: string }[] } };
  return message.result.tools.map((t) => t.name);
}

describe(`/mcp/:group routing (partition "${DEFAULT_PARTITION}")`, () => {
  it('serves only the named group on /mcp/<group>', async () => {
    const [first] = groupNames;
    const tools = await listToolNames(`/mcp/${first}`);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((t) => toolGroup.get(t) !== first)).toEqual([]);
    expect(calls.at(-1)?.group).toBe(first);
  }, 60_000);

  it('serves the full catalog on /mcp, the union of every group', async () => {
    const full = await listToolNames('/mcp');
    expect(calls.at(-1)?.group).toBeUndefined();

    let union = 0;
    for (const group of groupNames) union += (await listToolNames(`/mcp/${group}`)).length;
    expect(union).toBe(full.length);
  }, 120_000);

  it('passes the caller identity through unchanged', async () => {
    const last = groupNames.at(-1)!;
    await listToolNames(`/mcp/${last}`);
    expect(calls.at(-1)).toEqual({ userToken: 'good', roles: ['Tools.Write.High'], group: last });
  }, 60_000);

  it('answers 404 for an unknown group, without building a server', async () => {
    const before = calls.length;
    const other = Object.values(PARTITIONS)
      .flatMap((p) => Object.keys(p.groups))
      .find((g) => !groups.has(g));
    for (const name of ['powerplatform', groupNames[0].toUpperCase(), 'x%2F..', other ?? 'nope']) {
      const res = await post(`/mcp/${name}`);
      expect(res.status, name).toBe(404);
    }
    expect(calls.length).toBe(before);
  });

  it('authenticates group routes before resolving the group', async () => {
    const before = calls.length;
    expect((await post(`/mcp/${groupNames[0]}`, 'bad')).status).toBe(401);
    expect((await post('/mcp/does-not-exist', 'bad')).status).toBe(401);
    expect(calls.length).toBe(before);
  });
});
