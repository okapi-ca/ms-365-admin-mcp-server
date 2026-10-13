import { describe, it, expect, vi } from 'vitest';
import v8 from 'node:v8';
import vm from 'node:vm';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ListToolsResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { endpointSections, registerGraphTools } from '../src/graph-tools.js';
import {
  DEFAULT_PARTITION,
  PARTITIONS,
  groupToolSets,
  resolvePartition,
} from '../src/tool-partitions.js';
import type { RiskLevel } from '../src/risk-level.js';
import type GraphClient from '../src/graph-client.js';

// Node 18 lacks the File global referenced by generated Zod schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!globalThis.File) (globalThis as any).File = Blob;

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * In HTTP mode every request gets its own McpServer. Before the shared catalog,
 * each registerGraphTools() rebuilt the zod schemas of all 643 tools (~92 MB
 * retained per server) and each tools/list re-derived their JSON Schema, so
 * three concurrent tools/list calls on /mcp exhausted the ~512 MB heap of a
 * 2 Gi container and crashed the process. These tests pin the fix: per-tool
 * definitions are built once and shared, the tools/list output is unchanged,
 * and the per-caller filters still decide what each server exposes.
 */

const graphClient = { graphRequest: async () => ({ content: [] }) } as unknown as GraphClient;

type ListHandler = (
  request?: unknown,
  extra?: unknown
) => ListToolsResult | Promise<ListToolsResult>;

function register(writeRiskTiers?: Set<RiskLevel>): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerGraphTools(
    server,
    graphClient,
    false,
    undefined,
    'critical',
    graphClient,
    writeRiskTiers
  );
  return server;
}

// The handlers registered by the SDK are private; tests read them to compare
// the SDK's own tools/list against the cached one without a transport.
function listHandler(server: McpServer): ListHandler {
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, ListHandler> })
    ._requestHandlers;
  return handlers.get('tools/list')!;
}

async function listTools(server: McpServer): Promise<Tool[]> {
  return (await listHandler(server)({ method: 'tools/list', params: {} }, {})).tools;
}

function shapeOf(server: McpServer, tool: string): Record<string, unknown> {
  const registered = (
    server as unknown as {
      _registeredTools: Record<string, { inputSchema: { _zod: { def: { shape: object } } } }>;
    }
  )._registeredTools[tool];
  return registered.inputSchema._zod.def.shape as Record<string, unknown>;
}

const ALL_TIERS = new Set<RiskLevel>(['low', 'medium', 'high', 'critical']);
const identity = groupToolSets(
  resolvePartition(PARTITIONS[DEFAULT_PARTITION], endpointSections())
).get('identity')!;

describe('registerGraphTools — shared tool catalog', () => {
  // The cached listing is shared by every caller, so parity is checked for each
  // shape of server HTTP mode builds: full catalog, read-only caller, one group.
  it.each([
    { name: '/mcp, no per-caller filter', tiers: undefined, group: undefined, min: 600 },
    {
      name: '/mcp, caller without write roles',
      tiers: new Set<RiskLevel>(),
      group: undefined,
      min: 300,
    },
    { name: '/mcp/identity, all write roles', tiers: ALL_TIERS, group: identity, min: 200 },
  ])(
    'serves the exact tools/list the SDK would have produced ($name)',
    async ({ tiers, group, min }) => {
      const server = new McpServer({ name: 'test', version: '0.0.0' });
      const installed: ListHandler[] = [];
      const original = server.server.setRequestHandler.bind(server.server);
      vi.spyOn(server.server, 'setRequestHandler').mockImplementation((schema, handler) => {
        if ((schema.shape.method as { value: string }).value === 'tools/list') {
          installed.push(handler as ListHandler);
        }
        return original(schema, handler);
      });

      registerGraphTools(
        server,
        graphClient,
        false,
        undefined,
        'critical',
        graphClient,
        tiers,
        group && { name: 'identity', tools: group }
      );

      // First the SDK's handler (installed on the first server.tool()), then ours.
      expect(installed).toHaveLength(2);
      const [sdk, cached] = await Promise.all(installed.map((h) => h()));
      expect(cached.tools.length).toBeGreaterThan(min);
      expect(JSON.stringify(cached)).toBe(JSON.stringify(sdk));
    }
  );

  it('leaves disabled tools out of tools/list, as the SDK does', async () => {
    const server = register(ALL_TIERS);
    const tool = 'create-ediscovery-case';
    const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools[tool];

    registered.disable();

    const names = (await listTools(server)).map((t) => t.name);
    expect(names.length).toBeGreaterThan(600);
    expect(names).not.toContain(tool);
  });

  it('serves listings that no caller can alter for the next one', async () => {
    const [entry] = await listTools(register(ALL_TIERS));

    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.inputSchema)).toBe(true);
    expect(() => {
      (entry as { description?: string }).description = 'tampered';
    }).toThrow(TypeError);
    expect((await listTools(register(ALL_TIERS)))[0].description).not.toBe('tampered');
  });

  it('shares input schemas and listings across per-request servers', async () => {
    const first = register(new Set(['low', 'medium', 'high', 'critical']));
    const second = register(new Set(['low', 'medium', 'high', 'critical']));

    // Same zod instances: nothing is rebuilt for the second server.
    const tool = 'create-ediscovery-case';
    expect(Object.keys(shapeOf(first, tool)).length).toBeGreaterThan(0);
    for (const [param, schema] of Object.entries(shapeOf(first, tool))) {
      expect(shapeOf(second, tool)[param]).toBe(schema);
    }

    // Same listing objects: JSON Schema is derived once per tool, not per request.
    const [a, b] = [await listTools(first), await listTools(second)];
    expect(b).toHaveLength(a.length);
    b.forEach((entry, i) => expect(entry).toBe(a[i]));
  });

  it('keeps each caller to the tools its own filters allow (SEC-G05)', async () => {
    const writer = await listTools(register(new Set(['low', 'medium', 'high', 'critical'])));
    const reader = await listTools(register(new Set()));
    const writerAgain = await listTools(register(new Set(['low', 'medium', 'high', 'critical'])));

    const writes = (tools: Tool[]) => tools.filter((t) => !t.annotations?.readOnlyHint);
    expect(writes(writer).length).toBeGreaterThan(0);
    expect(writes(reader)).toEqual([]);
    expect(writerAgain.map((t) => t.name)).toEqual(writer.map((t) => t.name));
  });

  it('retains far less than a catalog rebuild per additional server', async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const tiers = new Set<RiskLevel>(['low', 'medium', 'high', 'critical']);
    const keep = [register(tiers)];
    await listTools(keep[0]);

    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 10; i++) {
      keep.push(register(tiers));
      await listTools(keep[i + 1]);
    }
    gc();
    const perServer = (process.memoryUsage().heapUsed - before) / 10;

    // Measured ~3 MB per full-catalog server with the shared catalog, ~92 MB
    // without it. 20 MB leaves room for allocator noise while still failing if
    // the schemas go back to being built per server.
    expect(keep).toHaveLength(11);
    expect(perServer).toBeLessThan(20 * 1024 * 1024);
  });
});
