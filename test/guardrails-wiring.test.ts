import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGraphTools } from '../src/graph-tools.js';
import type GraphClient from '../src/graph-client.js';

// Node 18 lacks the File global referenced by generated Zod schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!globalThis.File) (globalThis as any).File = Blob;

const GROUP = 'aaaaaaaa-0000-0000-0000-000000000001';
const TARGET = 'bbbbbbbb-0000-0000-0000-000000000002';
const OTHER = 'cccccccc-0000-0000-0000-000000000003';

type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

interface GraphCall {
  endpoint: string;
  method: string;
}

/**
 * Integration tests for the guardrail hook inside executeGraphTool: a block must
 * never reach Graph, a fail-open notice must land outside the untrusted-content
 * envelope, and a 403 must pick up the pre-flight's explanation.
 *
 * The guardrail decision logic itself is covered in guardrails.test.ts; here we
 * only assert the plumbing around it.
 */
function harness(responses: Record<string, { body?: unknown; error?: string }>): {
  handlerFor: (alias: string) => ToolHandler;
  calls: GraphCall[];
} {
  const calls: GraphCall[] = [];
  const handlers = new Map<string, ToolHandler>();

  const graphClient = {
    graphRequest: async (endpoint: string, options: { method?: string } = {}) => {
      const method = options.method ?? 'GET';
      calls.push({ endpoint, method });

      const key = Object.keys(responses).find((candidate) => endpoint.startsWith(candidate));
      if (key === undefined) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `unstubbed: ${endpoint}` }) }],
          isError: true,
        };
      }

      const stub = responses[key];
      if (stub.error !== undefined) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: stub.error }) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(stub.body ?? { message: 'OK!' }) }] };
    },
  } as unknown as GraphClient;

  const server = {
    tool: (
      alias: string,
      _description: string,
      _paramSchema: unknown,
      _meta: unknown,
      handler: ToolHandler
    ) => {
      handlers.set(alias, handler);
    },
  } as unknown as McpServer;

  registerGraphTools(server, graphClient, false, undefined, 'critical', undefined, undefined);

  return {
    handlerFor: (alias) => {
      const handler = handlers.get(alias);
      if (!handler) throw new Error(`tool not registered: ${alias}`);
      return handler;
    },
    calls,
  };
}

const plainGroup = { id: GROUP, displayName: 'Test-Group' };

describe('guardrail wiring in executeGraphTool', () => {
  it('blocks before any write reaches Graph', async () => {
    const { handlerFor, calls } = harness({
      [`/groups/${GROUP}?`]: { body: plainGroup },
      [`/groups/${GROUP}/owners?`]: { body: { value: [{ id: TARGET }] } },
    });

    const result = await handlerFor('remove-group-owner')({
      groupId: GROUP,
      directoryObjectId: TARGET,
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text) as { error: string; guardrail: string };
    expect(payload.guardrail).toBe('remove-group-owner');
    expect(payload.error).toContain('only owner');

    // Pre-flight reads only — the DELETE never went out.
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('leaves a block outside the untrusted-content envelope', async () => {
    const { handlerFor } = harness({
      [`/groups/${GROUP}?`]: { body: { ...plainGroup, onPremisesSyncEnabled: true } },
    });

    const result = await handlerFor('remove-group-member')({
      groupId: GROUP,
      directoryObjectId: TARGET,
    });

    // Server-generated errors are trustworthy and must not be wrapped.
    expect(result.content[0].text).not.toContain('<graph_response_');
  });

  it('prepends a fail-open notice outside the envelope, ahead of the Graph payload', async () => {
    const { handlerFor } = harness({
      [`/groups/${GROUP}?`]: { error: 'Microsoft Graph API error: 429 Too Many Requests' },
      [`/groups/${GROUP}/members/${TARGET}`]: { body: { message: 'OK!' } },
    });

    const result = await handlerFor('remove-group-member')({
      groupId: GROUP,
      directoryObjectId: TARGET,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toContain('checks were skipped');
    expect(result.content[0].text).not.toContain('<graph_response_');
    expect(result.content[1].text).toContain('<graph_response_');
  });

  it('appends the role-assignable explanation to a 403', async () => {
    const { handlerFor } = harness({
      [`/groups/${GROUP}?`]: { body: { ...plainGroup, isAssignableToRole: true } },
      [`/groups/${GROUP}/owners?`]: { body: { value: [{ id: TARGET }, { id: OTHER }] } },
      [`/groups/${GROUP}/owners/${TARGET}`]: {
        error: 'Microsoft Graph API error: 403 Forbidden (Authorization_RequestDenied)',
      },
    });

    const result = await handlerFor('remove-group-owner')({
      groupId: GROUP,
      directoryObjectId: TARGET,
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text) as {
      error: string;
      guardrailContext?: string[];
    };
    expect(payload.error).toContain('403');
    expect(payload.guardrailContext?.[0]).toContain('RoleManagement.ReadWrite.Directory');
  });

  it('does not annotate an error that is not a 403', async () => {
    const { handlerFor } = harness({
      [`/groups/${GROUP}?`]: { body: { ...plainGroup, isAssignableToRole: true } },
      [`/groups/${GROUP}/owners?`]: { body: { value: [{ id: TARGET }, { id: OTHER }] } },
      [`/groups/${GROUP}/owners/${TARGET}`]: {
        error: 'Microsoft Graph API error: 404 Not Found (Request_ResourceNotFound)',
      },
    });

    const result = await handlerFor('remove-group-owner')({
      groupId: GROUP,
      directoryObjectId: TARGET,
    });

    const payload = JSON.parse(result.content[0].text) as { guardrailContext?: string[] };
    expect(payload.guardrailContext).toBeUndefined();
  });

  it('runs no pre-flight for a tool without guardrails', async () => {
    const { handlerFor, calls } = harness({
      [`/groups/${GROUP}/members/`]: { body: { message: 'OK!' } },
    });

    await handlerFor('add-group-member')({
      groupId: GROUP,
      body: { '@odata.id': `https://graph.microsoft.com/v1.0/users/${TARGET}` },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
  });
});
