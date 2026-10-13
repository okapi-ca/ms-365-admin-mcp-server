import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { endpointSections, registerGraphTools } from '../src/graph-tools.js';
import {
  DEFAULT_PARTITION,
  PARTITIONS,
  groupToolSets,
  resolvePartition,
  type ToolPartition,
} from '../src/tool-partitions.js';
import type GraphClient from '../src/graph-client.js';

// Node 18 lacks the File global referenced by generated Zod schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!globalThis.File) (globalThis as any).File = Blob;

/**
 * The group endpoints (`/mcp/<group>`) only keep their promise — one Claude.ai
 * connector per group, each with its own schema budget, together covering the
 * whole catalog once — if every partition table is a partition. This suite pins
 * that for every table in tool-partitions.ts, not just the active one, so the
 * alternative stays switchable.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Half of Claude.ai's 1 MiB per-connector budget (input-schema bytes, compact
// JSON). Leaves room for a group to grow and for the local servers that the
// claude-device bridge folds into the same connector.
const GROUP_CEILING_BYTES = 512 * 1024;

const schemaBytes = (s: unknown) => Buffer.byteLength(JSON.stringify(s), 'utf8');

/** README `### Section (N)` → tool names, as readme-inventory.test.ts parses it. */
function readmeSections(): Map<string, string> {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8').split('\n');
  const start = readme.findIndex((l) => l.startsWith('## Available tools'));
  const end = readme.findIndex((l, i) => i > start && l.startsWith('## '));
  const sectionOf = new Map<string, string>();
  let current: string | undefined;
  for (const line of readme.slice(start + 1, end === -1 ? undefined : end)) {
    const heading = line.match(/^### (.+?)(?: \(\d+\))?(?: --.*)?$/);
    if (heading) {
      current = heading[1];
      continue;
    }
    const row = line.match(/^\|\s*`([a-z0-9-]+)`/);
    if (row && current) sectionOf.set(row[1], current);
  }
  return sectionOf;
}

async function listTools(group?: { name: string; tools: ReadonlySet<string> }) {
  const server = new McpServer({ name: 'probe', version: '0' });
  registerGraphTools(
    server,
    {} as GraphClient,
    false,
    undefined,
    'critical',
    undefined,
    undefined,
    group
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'probe', version: '0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe('endpoint sections', () => {
  it('match the README inventory section of every tool', () => {
    const readme = readmeSections();
    const drift = endpointSections()
      .filter((e) => readme.get(e.toolName) !== e.section)
      .map(
        (e) =>
          `${e.toolName}: "${e.section}" in endpoints.json, "${readme.get(e.toolName)}" in README`
      );
    expect(drift).toEqual([]);
  });
});

describe('resolvePartition', () => {
  const endpoints = [
    { toolName: 'a1', section: 'A' },
    { toolName: 'a2', section: 'A' },
    { toolName: 'b1', section: 'B' },
  ];

  it('places section tools in their group and moved tools in theirs', () => {
    const map = resolvePartition(
      {
        description: '',
        groups: { x: { sections: ['A'] }, y: { sections: ['B'], tools: ['a2'] } },
      },
      endpoints
    );
    expect(Object.fromEntries(map)).toEqual({ a1: 'x', a2: 'y', b1: 'y' });
  });

  it.each<[string, ToolPartition, RegExp]>([
    [
      'an unplaced section',
      { description: '', groups: { x: { sections: ['A'] } } },
      /"B".*no group/,
    ],
    [
      'a section in two groups',
      { description: '', groups: { x: { sections: ['A', 'B'] }, y: { sections: ['B'] } } },
      /"B" is in both x and y/,
    ],
    [
      'an unknown section',
      { description: '', groups: { x: { sections: ['A', 'B', 'C'] } } },
      /"C".*no tools/,
    ],
    [
      'an unknown moved tool',
      { description: '', groups: { x: { sections: ['A', 'B'], tools: ['zz'] } } },
      /zz.*does not exist/,
    ],
    [
      'a tool moved into its own group',
      { description: '', groups: { x: { sections: ['A', 'B'], tools: ['a1'] } } },
      /a1 is moved to x, which already owns/,
    ],
  ])('rejects %s', (_label, partition, message) => {
    expect(() => resolvePartition(partition, endpoints)).toThrow(message);
  });
});

describe.each(Object.entries(PARTITIONS))('partition "%s"', (_name, partition) => {
  it('places every tool in exactly one group', () => {
    const toolGroup = resolvePartition(partition, endpointSections());
    expect(toolGroup.size).toBe(endpointSections().length);
  });

  it('serves each tool from exactly one group, each under the per-group ceiling', async () => {
    const full = await listTools();
    const sets = groupToolSets(resolvePartition(partition, endpointSections()));
    const servedBy = new Map<string, string>();
    const oversized: string[] = [];

    for (const [name, tools] of sets) {
      const listed = await listTools({ name, tools });
      expect(listed.length, `${name} registers no tool`).toBeGreaterThan(0);
      for (const t of listed) {
        expect(servedBy.get(t.name), `${t.name} served by two groups`).toBeUndefined();
        servedBy.set(t.name, name);
      }
      const bytes = listed.reduce((sum, t) => sum + schemaBytes(t.inputSchema), 0);
      if (bytes >= GROUP_CEILING_BYTES) oversized.push(`${name}: ${bytes} bytes`);
    }

    expect(servedBy.size).toBe(full.length);
    expect(oversized).toEqual([]);
  }, 120_000);
});

it('keeps option B a union of option A domains', () => {
  // A is the default and B its coarsening, so moving between them
  // never reshuffles a tool across Entra role boundaries.
  const union: Record<string, string> = {
    identity: 'identity',
    intune: 'devices',
    security: 'security',
    purview: 'security',
    exchange: 'collaboration',
    sharepoint: 'collaboration',
    teams: 'collaboration',
  };
  const a = resolvePartition(PARTITIONS.domains, endpointSections());
  const b = resolvePartition(PARTITIONS.groups, endpointSections());
  const misplaced = [...a].filter(([tool, domain]) => b.get(tool) !== union[domain]);
  expect(misplaced.map(([tool, domain]) => `${tool}: ${domain} -> ${b.get(tool)}`)).toEqual([]);
});

it('defaults to a partition that exists', () => {
  expect(PARTITIONS[DEFAULT_PARTITION]).toBeDefined();
});
