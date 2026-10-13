import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { shallowBodySchema } from '../src/advertised-schema.js';
import { coerceJsonStringBody, registerGraphTools } from '../src/graph-tools.js';
import type GraphClient from '../src/graph-client.js';

// Node 18 lacks the File global referenced by generated Zod schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!globalThis.File) (globalThis as any).File = Blob;

// Claude.ai's per-connector budget: input-schema bytes, compact JSON, admitted in
// alphabetical order. The claude-device bridge relays every local server of a Mac as
// one connector, so this server only gets what the other local servers leave over.
const CONNECTOR_BUDGET_BYTES = 1_048_576;
// Headroom kept for those other servers; the write catalog measured 595 KB with it.
const CATALOG_CEILING_BYTES = 768 * 1024;

const schemaBytes = (s: unknown) => Buffer.byteLength(JSON.stringify(s), 'utf8');

// Shaped like the generator's output: an entity whose navigation property points
// back at an entity, through z.lazy, with Graph's "Read-only." convention.
type Node = { id?: string; name?: string; children?: Node[] };
const entity: z.ZodType<Node> = z.lazy(() =>
  z
    .object({
      id: z.string().describe('The unique identifier for an entity. Read-only.').optional(),
      name: z.string().describe('Display name.').nullish(),
      createdDateTime: z
        .string()
        .regex(/^[0-9]{4,}-[0-9]{2}-[0-9]{2}T.*$/)
        .datetime({ offset: true })
        .describe('ISO 8601 timestamp.')
        .nullish(),
      kind: z.enum(['a', 'b']).optional(),
      settings: z.object({ enabled: z.boolean().optional() }).describe('Settings.').optional(),
      children: z.array(entity).describe('Child nodes.').optional(),
    })
    .partial()
    .passthrough()
);

describe('shallowBodySchema', () => {
  const json = z.toJSONSchema(shallowBodySchema(entity)) as {
    properties: Record<string, Record<string, unknown>>;
    definitions?: unknown;
    $defs?: unknown;
  };
  const text = JSON.stringify(json);

  it('keeps the entity’s own settable fields with their descriptions', () => {
    expect(Object.keys(json.properties).sort()).toEqual(
      ['children', 'createdDateTime', 'kind', 'name', 'settings'].sort()
    );
    expect(text).toContain('Display name.');
    expect(text).toContain('"enum":["a","b"]');
  });

  it('drops fields Graph marks Read-only', () => {
    expect(json.properties.id).toBeUndefined();
  });

  it('turns nested objects into free-form objects that keep their description', () => {
    const settings = JSON.stringify(json.properties.settings);
    expect(settings).toContain('Settings.');
    expect(settings).not.toContain('enabled');
    expect(JSON.stringify(json.properties.children)).not.toContain('Display name.');
  });

  it('stops the z.lazy recursion instead of emitting definitions', () => {
    expect(json.definitions).toBeUndefined();
    expect(json.$defs).toBeUndefined();
  });

  it('drops the generated timestamp patterns', () => {
    expect(text).not.toContain('pattern');
    expect(text).toContain('ISO 8601 timestamp.');
  });

  it('leaves the payload untouched once wrapped as the tool registers it', () => {
    const payload = {
      id: 'kept-even-if-read-only',
      name: 'n',
      createdDateTime: 'not-a-date',
      settings: { enabled: true, extra: 1 },
      children: [{ name: 'c', children: [{ name: 'deep', unknown: [1, 2] }] }],
    };
    const parsed = coerceJsonStringBody(shallowBodySchema(entity)).parse(payload);
    expect(parsed).toEqual(payload);
  });
});

describe('advertised catalog size, measured through the MCP transport', () => {
  it('fits the write catalog well under the connector budget', async () => {
    const server = new McpServer({ name: 'probe', version: '0' });
    registerGraphTools(server, {} as GraphClient, false, undefined, 'critical');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'probe', version: '0' });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    await client.close();

    const sizes = tools.map((t) => schemaBytes(t.inputSchema));
    const total = sizes.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(CATALOG_CEILING_BYTES);
    expect(CATALOG_CEILING_BYTES).toBeLessThan(CONNECTOR_BUDGET_BYTES);
    // No single tool may crowd out the reads that sort after it.
    expect(Math.max(...sizes)).toBeLessThan(16 * 1024);
  }, 60_000);
});
