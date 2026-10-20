import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { compactValue, shapeResponseText, toTable } from '../src/output-shape.js';
import { acceptsOutputShape, registerGraphTools } from '../src/graph-tools.js';
import type GraphClient from '../src/graph-client.js';

// Node 18 lacks the File global referenced by generated Zod schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!globalThis.File) (globalThis as any).File = Blob;

const managedDevices = {
  '@odata.count': 2,
  '@odata.nextLink':
    'https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$skiptoken=x',
  value: [
    {
      id: 'd1',
      deviceName: 'CLARA-01',
      isEncrypted: false,
      userPrincipalName: null,
      notes: '',
      configurationManagerClientEnabledFeatures: null,
      deviceActionResults: [],
      hardwareInformation: { tpmVersion: null, manufacturer: '' },
    },
    { id: 'd2', deviceName: 'SAGE-07', isEncrypted: true, userPrincipalName: 'a@lci.test' },
  ],
};

describe('compactValue', () => {
  it('drops null, empty-string, empty-array and empty-object fields, recursively', () => {
    expect(compactValue({ a: null, b: '', c: [], d: { e: null }, f: 0, g: false, h: 'x' })).toEqual(
      { f: 0, g: false, h: 'x' }
    );
  });

  it('keeps array positions', () => {
    expect(compactValue({ a: [1, null, ''] })).toEqual({ a: [1, null, null] });
  });
});

describe('toTable', () => {
  it('names each column once, in order of first appearance, with null for missing cells', () => {
    expect(
      toTable(
        {
          n: 1,
          value: [
            { a: 1, b: 2 },
            { b: 3, c: 4 },
          ],
        },
        'value'
      )
    ).toEqual({
      n: 1,
      columns: ['a', 'b', 'c'],
      rows: [
        [1, 2, null],
        [null, 3, 4],
      ],
    });
  });

  it('leaves a list of non-objects alone', () => {
    const payload = { value: ['a', 'b'] };
    expect(toTable(payload, 'value')).toBe(payload);
  });
});

describe('shapeResponseText', () => {
  const text = JSON.stringify(managedDevices, null, 2);

  it('compact keeps every non-empty field and the paging annotations', () => {
    const out = JSON.parse(shapeResponseText(text, 'compact'));
    expect(out['@odata.nextLink']).toBe(managedDevices['@odata.nextLink']);
    expect(out['@odata.count']).toBe(2);
    expect(out.value[0]).toEqual({ id: 'd1', deviceName: 'CLARA-01', isEncrypted: false });
    expect(out.value[1]).toEqual(managedDevices.value[1]);
  });

  it('table is smaller than compact, which is smaller than the original', () => {
    const compact = shapeResponseText(text, 'compact');
    const table = shapeResponseText(text, 'table');
    expect(compact.length).toBeLessThan(text.length);
    expect(table.length).toBeLessThan(compact.length);
    expect(JSON.parse(table)).toMatchObject({
      columns: ['id', 'deviceName', 'isEncrypted', 'userPrincipalName'],
      rows: [
        ['d1', 'CLARA-01', false, null],
        ['d2', 'SAGE-07', true, 'a@lci.test'],
      ],
    });
  });

  it('keeps an empty list as the answer', () => {
    expect(JSON.parse(shapeResponseText('{"value":[]}', 'compact'))).toEqual({ value: [] });
    expect(JSON.parse(shapeResponseText('{"value":[]}', 'table'))).toEqual({
      columns: [],
      rows: [],
    });
  });

  it('reshapes the list under another key when told to', () => {
    const out = JSON.parse(
      shapeResponseText(JSON.stringify({ devices: [{ a: 1 }], notFound: [] }), 'table', 'devices')
    );
    expect(out).toEqual({ columns: ['a'], rows: [[1]] });
  });

  it('returns text that is not a JSON object unchanged', () => {
    expect(shapeResponseText('Report Refresh Date,User\n2026-10-01,a', 'table')).toBe(
      'Report Refresh Date,User\n2026-10-01,a'
    );
    expect(shapeResponseText('[1,2]', 'compact')).toBe('[1,2]');
  });
});

describe('acceptsOutputShape', () => {
  const get = (pathPattern: string, extra = {}) => ({ method: 'get', pathPattern, ...extra });

  it('applies to collection reads only', () => {
    expect(acceptsOutputShape(get('/deviceManagement/managedDevices') as never)).toBe(true);
    expect(acceptsOutputShape(get('/users/{user-id}') as never)).toBe(false);
    expect(
      acceptsOutputShape(get("/reports/getEmailActivityCounts(period='{period}')") as never)
    ).toBe(false);
    expect(acceptsOutputShape(get('/x', { acceptType: 'text/csv' }) as never)).toBe(false);
    expect(acceptsOutputShape({ method: 'post', pathPattern: '/x' } as never)).toBe(false);
  });
});

/** Registers the catalog against a stub server and a fake Graph answering `body`. */
function register(body: unknown) {
  const wire: { endpoint: string }[] = [];
  const graphClient = {
    graphRequest: async (endpoint: string) => {
      wire.push({ endpoint });
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
    },
  } as unknown as GraphClient;
  const tools = new Map<
    string,
    { shape: Record<string, z.ZodTypeAny>; call: (p: Record<string, unknown>) => Promise<unknown> }
  >();
  const server = {
    tool: (
      alias: string,
      _d: string,
      shape: Record<string, z.ZodTypeAny>,
      _a: unknown,
      handler: (p: Record<string, unknown>) => Promise<unknown>
    ) => {
      const schema = z.object(shape);
      tools.set(alias, {
        shape,
        call: (params) => handler(schema.parse(params) as Record<string, unknown>),
      });
      return { enabled: true };
    },
    server: { setRequestHandler: () => {} },
  } as unknown as McpServer;
  registerGraphTools(server, graphClient, false, undefined, 'critical');
  return { tools, wire };
}

const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0].text;

describe('shape on a registered tool', () => {
  it('is offered on collection reads, not on entity reads or writes', () => {
    const { tools } = register({});
    expect(tools.get('list-managed-devices')!.shape.shape).toBeDefined();
    expect(tools.get('get-managed-devices-by-names')!.shape.shape).toBeDefined();
    expect(tools.get('get-managed-device')!.shape.shape).toBeUndefined();
    expect(tools.get('delete-managed-device')!.shape.shape).toBeUndefined();
  });

  it('reshapes inside the untrusted-content envelope and stays off the Graph URL', async () => {
    const { tools, wire } = register(managedDevices);

    const text = textOf(await tools.get('list-managed-devices')!.call({ shape: 'table', top: 5 }));

    expect(wire[0].endpoint).not.toContain('shape');
    expect(text).toMatch(/^<graph_response_[0-9a-f]{16} tool="list-managed-devices"/);
    expect(text).toContain('"columns":["id","deviceName","isEncrypted","userPrincipalName"]');
  });

  it('leaves the response as it was without shape', async () => {
    const { tools } = register(managedDevices);
    const text = textOf(await tools.get('list-managed-devices')!.call({}));
    expect(text).toContain('"configurationManagerClientEnabledFeatures": null');
  });

  it('rejects an unknown shape before calling Graph', () => {
    const { tools, wire } = register(managedDevices);
    expect(() => tools.get('list-managed-devices')!.call({ shape: 'csv' })).toThrow();
    expect(wire).toHaveLength(0);
  });
});
