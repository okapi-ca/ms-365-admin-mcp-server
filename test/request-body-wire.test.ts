import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerGraphTools } from '../src/graph-tools.js';
import type GraphClient from '../src/graph-client.js';

// Node 18 lacks the File global referenced by generated Zod schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!globalThis.File) (globalThis as any).File = Blob;

/**
 * SEC-F2: asserts the bytes a write tool actually puts on the wire.
 *
 * The suite exists because nothing did. `coerceJsonStringBody` was unit-tested in
 * isolation, and the guardrail wiring tests only matched on the endpoint — so a
 * body-mangling bug in executeGraphTool went unnoticed until a real offboarding
 * was replayed against the tenant.
 *
 * The bug: on a generated-schema miss, the payload was re-parsed wrapped as
 * `{ body: payload }` and sent when that validated. For the six POST …/$ref
 * endpoints the generated schema is `z.record(z.object({}).partial().passthrough())`,
 * which REJECTS the real `{ "@odata.id": "https://…" }` (string value) and ACCEPTS
 * the wrapped `{ body: { … } }` (object value). Graph answered 400
 * Request_BadRequest on every add-member / add-owner call.
 */

const CAPTURE = { endpoint: '', method: '', body: undefined as string | undefined };

/**
 * Invokes a tool the way the MCP SDK does: the registered Zod shape validates the
 * arguments first, then the handler runs. Going straight at the handler would skip
 * `coerceJsonStringBody`, which lives in that shape — and skipping it is what made
 * the first draft of this suite disagree with production.
 */
function harness(): Map<string, (p: Record<string, unknown>) => Promise<unknown>> {
  const calls = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();

  const graphClient = {
    graphRequest: async (endpoint: string, options: { method?: string; body?: string } = {}) => {
      CAPTURE.endpoint = endpoint;
      CAPTURE.method = options.method ?? 'GET';
      CAPTURE.body = options.body;
      return { content: [{ type: 'text', text: '{"message":"OK!"}' }] };
    },
  } as unknown as GraphClient;

  const server = {
    tool: (
      alias: string,
      _d: string,
      paramSchema: Record<string, z.ZodTypeAny>,
      _m: unknown,
      handler: (p: Record<string, unknown>) => Promise<unknown>
    ) => {
      const shape = z.object(paramSchema);
      calls.set(alias, (params) => handler(shape.parse(params) as Record<string, unknown>));
    },
  } as unknown as McpServer;

  registerGraphTools(server, graphClient, false, undefined, 'critical', undefined, undefined);
  return calls;
}

const handlers = harness();

/** The six POST …/$ref navigation-property endpoints, and the id each one links. */
const REF_TOOLS: Array<{ alias: string; params: Record<string, unknown> }> = [
  { alias: 'add-group-member', params: { groupId: 'G' } },
  { alias: 'add-group-owner', params: { groupId: 'G' } },
  { alias: 'add-directory-role-member', params: { directoryRoleId: 'R' } },
  { alias: 'add-administrative-unit-member', params: { administrativeUnitId: 'A' } },
  { alias: 'add-application-owner', params: { applicationId: 'APP' } },
  { alias: 'add-sp-owner', params: { servicePrincipalId: 'SP' } },
];

const ODATA_REF = { '@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/U' };

describe('request body reaches Graph unwrapped', () => {
  it.each(REF_TOOLS)('$alias sends the @odata.id body verbatim', async ({ alias, params }) => {
    const handler = handlers.get(alias);
    expect(handler, `${alias} is registered`).toBeDefined();

    await handler!({ ...params, body: ODATA_REF });

    expect(CAPTURE.method).toBe('POST');
    expect(CAPTURE.body, `${alias} must send a body`).toBeDefined();

    const sent = JSON.parse(CAPTURE.body!);
    // The regression: sent was { body: { '@odata.id': ... } }, which Graph rejects.
    expect(sent).toEqual(ODATA_REF);
    expect(sent).not.toHaveProperty('body');
  });

  it('sends a plain entity body verbatim too (create-group)', async () => {
    const payload = {
      displayName: 'Test-Group',
      mailEnabled: false,
      mailNickname: 'zztest',
      securityEnabled: true,
    };

    await handlers.get('create-group')!({ body: payload });

    expect(CAPTURE.method).toBe('POST');
    expect(JSON.parse(CAPTURE.body!)).toEqual(payload);
  });

  it('parses a JSON-string body before sending, without wrapping it', async () => {
    // Some MCP clients downgrade an object parameter to a JSON string; the
    // coerceJsonStringBody preprocessor handles that, and the result must still
    // reach the wire unwrapped.
    await handlers.get('add-group-member')!({ groupId: 'G', body: JSON.stringify(ODATA_REF) });

    expect(JSON.parse(CAPTURE.body!)).toEqual(ODATA_REF);
  });

  it('sends no body for a DELETE that takes none', async () => {
    await handlers.get('remove-group-owner')!({ groupId: 'G', directoryObjectId: 'U' });

    expect(CAPTURE.method).toBe('DELETE');
    expect(CAPTURE.body).toBeUndefined();
  });
});
