import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  BATCH_SIZE,
  compositeEndpoints,
  compositeTools,
  deviceNameFilter,
  getManagedDevicesByNames,
  normaliseDeviceNames,
  withDeviceName,
} from '../src/composite-tools.js';
import { registerGraphTools } from '../src/graph-tools.js';
import { buildPermissionsFromEndpoints } from '../src/auth.js';
import type GraphClient from '../src/graph-client.js';

// Node 18 lacks the File global referenced by generated Zod schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!globalThis.File) (globalThis as any).File = Blob;

interface SubRequest {
  id: string;
  method: string;
  url: string;
}

interface SubResponse {
  id: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * Fake Graph that answers $batch calls. `answer` maps one sub-request to its
 * response; every batch body is recorded so tests can assert what went on the
 * wire.
 */
function fakeGraph(answer: (req: SubRequest, call: number) => Omit<SubResponse, 'id'>) {
  const batches: { endpoint: string; method?: string; requests: SubRequest[] }[] = [];
  const client = {
    graphRequest: async (endpoint: string, options: { method?: string; body?: string } = {}) => {
      const { requests } = JSON.parse(options.body ?? '{}') as { requests: SubRequest[] };
      batches.push({ endpoint, method: options.method, requests });
      const responses = requests.map((r) => ({ id: r.id, ...answer(r, batches.length) }));
      return { content: [{ type: 'text', text: JSON.stringify({ responses }) }] };
    },
  } as unknown as GraphClient;
  return { client, batches };
}

/** The device name a sub-request filters on, decoded back from its URL. */
function nameIn(req: SubRequest): string {
  const filter = new URL(`https://graph${req.url}`).searchParams.get('$filter') ?? '';
  return filter
    .replace(/^deviceName eq '/, '')
    .replace(/'$/, '')
    .replace(/''/g, "'");
}

const device = (name: string, id = `id-${name}`) => ({
  '@odata.type': '#microsoft.graph.managedDevice',
  '@odata.etag': 'W/"1"',
  id,
  deviceName: name,
  isEncrypted: false,
});

const noSleep = async () => {};

describe('deviceNameFilter', () => {
  it('quotes the name as an OData string literal', () => {
    expect(deviceNameFilter('CLARA-01')).toBe("deviceName eq 'CLARA-01'");
  });

  it('escapes a single quote by doubling it', () => {
    expect(deviceNameFilter("O'BRIEN-PC")).toBe("deviceName eq 'O''BRIEN-PC'");
    expect(deviceNameFilter("x' or deviceName ne '")).toBe(
      "deviceName eq 'x'' or deviceName ne '''"
    );
  });
});

describe('normaliseDeviceNames', () => {
  it('trims, drops blanks and duplicates, keeping the first spelling', () => {
    expect(normaliseDeviceNames([' PC-1 ', 'pc-1', '', '  ', 'PC-2', 'PC-1'])).toEqual([
      'PC-1',
      'PC-2',
    ]);
  });
});

describe('withDeviceName', () => {
  it('adds deviceName to a projection that lacks it', () => {
    expect(withDeviceName('isEncrypted, osVersion')).toBe('deviceName,isEncrypted,osVersion');
  });

  it('keeps a projection that already has it', () => {
    expect(withDeviceName('DeviceName,isEncrypted')).toBe('DeviceName,isEncrypted');
  });

  it('leaves no projection when none is asked for', () => {
    expect(withDeviceName(undefined)).toBeUndefined();
    expect(withDeviceName('  ')).toBeUndefined();
  });
});

describe('getManagedDevicesByNames', () => {
  it('sends one deviceName eq GET per name, 20 per $batch call', async () => {
    const names = Array.from({ length: 45 }, (_, i) => `PC-${i}`);
    const { client, batches } = fakeGraph((req) => ({
      status: 200,
      body: { value: [device(nameIn(req))] },
    }));

    const result = await getManagedDevicesByNames(client, names, undefined, noSleep);

    expect(batches.map((b) => b.requests.length)).toEqual([BATCH_SIZE, BATCH_SIZE, 5]);
    for (const batch of batches) {
      expect(batch.endpoint).toBe('/$batch');
      expect(batch.method).toBe('POST');
      for (const req of batch.requests) {
        expect(req.method).toBe('GET');
        expect(req.url.startsWith('/deviceManagement/managedDevices?$filter=')).toBe(true);
      }
    }
    expect(batches.flatMap((b) => b.requests.map(nameIn))).toEqual(names);
    expect(result).toMatchObject({ requested: 45, found: 45, batches: 3, notFound: [] });
    expect(result.devices).toHaveLength(45);
  });

  it('puts an escaped, URL-encoded filter on the wire', async () => {
    const { client, batches } = fakeGraph(() => ({ status: 200, body: { value: [] } }));

    await getManagedDevicesByNames(client, ["O'BRIEN & CO"], undefined, noSleep);

    const url = batches[0].requests[0].url;
    // A raw '&' would end the $filter value and start a new query parameter.
    expect(url).not.toContain(' ');
    expect(url).toContain('%26');
    expect(decodeURIComponent(url)).toBe(
      "/deviceManagement/managedDevices?$filter=deviceName eq 'O''BRIEN & CO'"
    );
  });

  it('applies the projection to every sub-request, deviceName included', async () => {
    const { client, batches } = fakeGraph(() => ({ status: 200, body: { value: [] } }));

    await getManagedDevicesByNames(client, ['A', 'B'], 'isEncrypted', noSleep);

    for (const req of batches[0].requests) {
      expect(new URL(`https://graph${req.url}`).searchParams.get('$select')).toBe(
        'deviceName,isEncrypted'
      );
    }
  });

  it('merges matches, unknown names and names shared by several devices', async () => {
    const { client } = fakeGraph((req) => {
      const name = nameIn(req);
      if (name === 'GHOST') return { status: 200, body: { value: [] } };
      if (name === 'TWIN')
        return { status: 200, body: { value: [device('TWIN', 't1'), device('TWIN', 't2')] } };
      return { status: 200, body: { value: [device(name)] } };
    });

    const result = await getManagedDevicesByNames(client, ['A', 'GHOST', 'TWIN'], undefined);

    expect(result.found).toBe(2);
    expect(result.notFound).toEqual(['GHOST']);
    expect(result.multipleMatches).toEqual({ TWIN: 2 });
    expect(result.devices.map((d) => d.id)).toEqual(['id-A', 't1', 't2']);
    // Same annotations as list-managed-devices: GraphClient keeps @odata.type.
    expect(result.devices.every((d) => d['@odata.type'] === '#microsoft.graph.managedDevice')).toBe(
      true
    );
    expect(result.devices.every((d) => !('@odata.etag' in d))).toBe(true);
  });

  it('retries throttled lookups after Retry-After, then reports what still fails', async () => {
    const delays: number[] = [];
    const { client, batches } = fakeGraph((req, call) => {
      const name = nameIn(req);
      if (name === 'SLOW' && call === 1)
        return { status: 429, headers: { 'Retry-After': '3' }, body: {} };
      if (name === 'STUCK') return { status: 503, body: {} };
      if (name === 'DENIED')
        return { status: 403, body: { error: { code: 'Forbidden', message: 'No access' } } };
      return { status: 200, body: { value: [device(name)] } };
    });

    const result = await getManagedDevicesByNames(
      client,
      ['OK', 'SLOW', 'STUCK', 'DENIED'],
      undefined,
      async (ms) => {
        delays.push(ms);
      }
    );

    expect(delays[0]).toBe(3000);
    // Two retry rounds after the first attempt, then STUCK is given up on.
    expect(batches.map((b) => b.requests.map(nameIn))).toEqual([
      ['OK', 'SLOW', 'STUCK', 'DENIED'],
      ['SLOW', 'STUCK'],
      ['STUCK'],
    ]);
    expect(result.devices.map((d) => d.deviceName)).toEqual(['OK', 'SLOW']);
    expect(result.errors).toEqual([
      { deviceName: 'DENIED', status: 403, error: 'Forbidden: No access' },
      { deviceName: 'STUCK', status: 503, error: 'Request failed' },
    ]);
    expect(result.found).toBe(2);
  });

  it('fails the call when the $batch request itself fails', async () => {
    const client = {
      graphRequest: async () => ({
        content: [{ type: 'text', text: '{"error":"Microsoft Graph API error: 403 Forbidden"}' }],
        isError: true,
      }),
    } as unknown as GraphClient;

    await expect(getManagedDevicesByNames(client, ['A'], undefined, noSleep)).rejects.toThrow(
      /403 Forbidden/
    );
  });
});

/** Registers the catalog against a stub server, the way request-body-wire.test.ts does. */
function register(graphClient: GraphClient, options: { readOnly?: boolean; filter?: string } = {}) {
  const calls = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    tool: (
      alias: string,
      _d: string,
      shape: Record<string, z.ZodTypeAny>,
      _a: unknown,
      handler: (p: Record<string, unknown>) => Promise<unknown>
    ) => {
      const schema = z.object(shape);
      calls.set(alias, (params) => handler(schema.parse(params) as Record<string, unknown>));
      return { enabled: true };
    },
    server: { setRequestHandler: () => {} },
  } as unknown as McpServer;
  registerGraphTools(server, graphClient, options.readOnly ?? false, options.filter, 'critical');
  return calls;
}

describe('get-managed-devices-by-names as an MCP tool', () => {
  const graph = fakeGraph((req) => ({ status: 200, body: { value: [device(nameIn(req))] } }));

  it('is registered in read-only mode, since it only reads', () => {
    expect(register(graph.client, { readOnly: true }).has('get-managed-devices-by-names')).toBe(
      true
    );
  });

  it('honours the tool filter like any other tool', () => {
    expect(
      register(graph.client, { filter: '^list-users$' }).has('get-managed-devices-by-names')
    ).toBe(false);
  });

  it('wraps the merged result in the untrusted-content envelope', async () => {
    const call = register(graph.client).get('get-managed-devices-by-names')!;

    const result = (await call({ deviceNames: ['PC-1'] })) as { content: { text: string }[] };
    const text = result.content[0].text;

    expect(text).toMatch(/^<graph_response_[0-9a-f]{16} tool="get-managed-devices-by-names"/);
    expect(text).toContain('"deviceName":"PC-1"');
  });

  it('accepts names sent as one string, as some clients send arrays', async () => {
    const call = register(graph.client).get('get-managed-devices-by-names')!;

    const result = (await call({ deviceNames: 'PC-1, PC-2\nPC-3' })) as {
      content: { text: string }[];
    };

    expect(result.content[0].text).toContain('"requested":3');
  });

  it('rejects an empty list before calling Graph', async () => {
    const call = register(graph.client).get('get-managed-devices-by-names')!;
    const before = graph.batches.length;
    expect(() => call({ deviceNames: [] })).toThrow(/>=1/);
    expect(graph.batches).toHaveLength(before);
  });
});

describe('composite catalog metadata', () => {
  it('declares app permissions, a section and a README-safe name for every composite', () => {
    for (const e of compositeEndpoints) {
      expect(e.appPermissions.length).toBeGreaterThan(0);
      expect(e.section).not.toBe('');
      expect(e.toolName).toMatch(/^[a-z0-9-]+$/);
    }
    expect(compositeEndpoints.map((e) => e.toolName)).toEqual(
      compositeTools.map((t) => t.toolName)
    );
  });

  it('feeds --list-permissions', () => {
    expect(buildPermissionsFromEndpoints('^get-managed-devices-by-names$', true)).toEqual([
      'DeviceManagementManagedDevices.Read.All',
    ]);
  });
});
