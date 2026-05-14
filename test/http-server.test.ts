import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';

// Mock the JWT-validating modules BEFORE importing http-server, so the
// middleware picks up our stubs instead of reaching out to JWKS. This keeps
// the test focused on the RFC 6750 §3.1 status mapping (invalid_token → 401,
// insufficient_scope → 403) without re-testing the underlying signature
// verification logic, which is exercised in user-token-validator.test.ts.
//
// vi.hoisted is required because vi.mock factories are hoisted to the top of
// the file before any const declarations. The stubs must be created in a
// hoisted block so the factories can close over them.
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

import { createMcpAuthMiddleware } from '../src/http-server.js';
import type { TokenValidatorOptions } from '../src/token-validator.js';
import type { UserTokenValidatorOptions } from '../src/user-token-validator.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';
const PUBLIC_URL = 'https://mcp.example.com';
const VALID_CLAIMS = {
  oid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  upn: 'alice@contoso.com',
  name: 'Alice',
  appid: CLIENT_ID,
  roles: [] as string[],
};

const userValidator: UserTokenValidatorOptions = {
  tenantId: TENANT,
  expectedAudiences: [CLIENT_ID, `api://${CLIENT_ID}`],
  authorizedUserOids: [],
  allowAnyTenantUser: true,
  requiredScopes: ['access_as_user'],
};

const serviceValidator: TokenValidatorOptions = {
  tenantId: TENANT,
  allowedClientIds: [CLIENT_ID],
  expectedAudience: `api://${CLIENT_ID}`,
};

interface BuiltServer {
  url: string;
  server: Server;
}

async function buildServer(opts: {
  withUserValidator?: boolean;
  withServiceValidator?: boolean;
  withOauthPublicUrl?: boolean;
}): Promise<BuiltServer> {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  app.use(
    '/mcp',
    createMcpAuthMiddleware({
      userValidator: opts.withUserValidator ? userValidator : undefined,
      serviceValidator: opts.withServiceValidator ? serviceValidator : undefined,
      oauthPublicUrl: opts.withOauthPublicUrl ? PUBLIC_URL : undefined,
    })
  );

  // Downstream endpoint that only fires when the middleware calls next().
  // The body echoes whether the user-OBO bearer was forwarded via res.locals
  // so we can assert the user-token path stores the raw bearer correctly.
  app.post('/mcp', (req, res) => {
    res.status(200).json({
      ok: true,
      hasUserToken: typeof res.locals.userToken === 'string',
    });
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve({ url: `http://127.0.0.1:${addr.port}`, server });
      }
    });
  });
}

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  // Build with both validators wired and OAuth metadata enabled — covers the
  // common production config (user OBO + service principal fallback).
  const built = await buildServer({
    withUserValidator: true,
    withServiceValidator: true,
    withOauthPublicUrl: true,
  });
  baseUrl = built.url;
  server = built.server;
});

afterAll(() => {
  server.close();
});

async function postMcp(authHeader?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authHeader) headers.Authorization = authHeader;
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
}

function resetMocks(): void {
  validateUserTokenExplainMock.mockReset();
  validateEntraTokenExplainMock.mockReset();
}

describe('createMcpAuthMiddleware — RFC 6750 §3.1 status mapping', () => {
  // This is the regression suite for the "Token validation failed → 403"
  // bug that broke mcp-remote refresh in production. Expired access tokens
  // MUST surface as 401 invalid_token so the client refreshes; only a
  // genuinely scoped-down token may surface as 403 insufficient_scope.

  it('returns 401 with WWW-Authenticate when no Authorization header is present', async () => {
    resetMocks();
    const res = await postMcp();
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate');
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(
      `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`
    );
    // The "no bearer" path should not announce an error code — the client
    // hasn't presented credentials yet.
    expect(challenge).not.toContain('error=');
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Missing or invalid Authorization header');
  });

  it('returns 401 with WWW-Authenticate when the header is not a Bearer token', async () => {
    resetMocks();
    const res = await postMcp('Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
  });

  it('returns 200 and forwards the user bearer when the user token is valid', async () => {
    resetMocks();
    validateUserTokenExplainMock.mockResolvedValueOnce({ ok: true, claims: VALID_CLAIMS });
    const res = await postMcp('Bearer valid-user-token');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; hasUserToken: boolean };
    expect(body.ok).toBe(true);
    expect(body.hasUserToken).toBe(true);
    // Service validator must NOT be consulted once the user path succeeds —
    // both for performance and to avoid double-counting auth events.
    expect(validateEntraTokenExplainMock).not.toHaveBeenCalled();
    expect(validateUserTokenExplainMock).toHaveBeenCalledWith(
      'valid-user-token',
      expect.objectContaining({ tenantId: TENANT })
    );
  });

  it('returns 200 when the user path rejects but the service path accepts', async () => {
    resetMocks();
    validateUserTokenExplainMock.mockResolvedValueOnce({ ok: false, reason: 'invalid_token' });
    validateEntraTokenExplainMock.mockResolvedValueOnce({
      ok: true,
      claims: { clientId: CLIENT_ID, roles: [] },
    });
    const res = await postMcp('Bearer valid-service-token');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; hasUserToken: boolean };
    // Service tokens do not populate res.locals.userToken — there is no UPN
    // to perform on-behalf-of with downstream.
    expect(body.hasUserToken).toBe(false);
  });

  it('returns 401 invalid_token when both validators reject with invalid_token (THE bug fix)', async () => {
    // This is the exact production failure mode: an expired user access
    // token. Pre-fix the server returned 403, mcp-remote did not attempt a
    // refresh (it only refreshes on 401 per the MCP spec), and the client
    // looped on the same dead token. After the fix, 401 makes the client
    // refresh and recover automatically.
    resetMocks();
    validateUserTokenExplainMock.mockResolvedValueOnce({ ok: false, reason: 'invalid_token' });
    validateEntraTokenExplainMock.mockResolvedValueOnce({ ok: false, reason: 'invalid_token' });
    const res = await postMcp('Bearer expired-token');
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate');
    expect(challenge).toContain('error="invalid_token"');
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_token');
  });

  it('returns 403 insufficient_scope when the user path rejects on missing scope and no service fallback succeeds', async () => {
    resetMocks();
    validateUserTokenExplainMock.mockResolvedValueOnce({
      ok: false,
      reason: 'insufficient_scope',
    });
    validateEntraTokenExplainMock.mockResolvedValueOnce({ ok: false, reason: 'invalid_token' });
    const res = await postMcp('Bearer scoped-down-token');
    expect(res.status).toBe(403);
    const challenge = res.headers.get('www-authenticate');
    expect(challenge).toContain('error="insufficient_scope"');
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('insufficient_scope');
  });

  it('insufficient_scope on the user path is rescued by a successful service token', async () => {
    // A service principal that bypasses user-scope checks should still get
    // through — e.g. an admin runbook calling on its own behalf. The
    // user-path insufficient_scope must NOT poison the eventual outcome.
    resetMocks();
    validateUserTokenExplainMock.mockResolvedValueOnce({
      ok: false,
      reason: 'insufficient_scope',
    });
    validateEntraTokenExplainMock.mockResolvedValueOnce({
      ok: true,
      claims: { clientId: CLIENT_ID, roles: [] },
    });
    const res = await postMcp('Bearer admin-service-token');
    expect(res.status).toBe(200);
  });

  it('omits WWW-Authenticate entirely when no oauthPublicUrl is configured', async () => {
    // Without an OAuth proxy there is no resource-metadata document to point
    // clients at; RFC 9728 §5.1 says the challenge MAY be omitted in that
    // case, and the server SHOULD avoid advertising a metadata URL it does
    // not host.
    resetMocks();
    const built = await buildServer({
      withUserValidator: true,
      withServiceValidator: false,
      withOauthPublicUrl: false,
    });
    try {
      validateUserTokenExplainMock.mockResolvedValueOnce({
        ok: false,
        reason: 'invalid_token',
      });
      const res = await fetch(`${built.url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
        body: '{}',
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBeNull();
    } finally {
      built.server.close();
    }
  });

  it('returns 401 when only the service validator is configured and rejects', async () => {
    // Service-only deployments (no OAuth proxy, --allowed-clients only) must
    // still emit 401 on token failure so machine-to-machine clients can
    // detect transient credential issues vs. permanent authorization gaps.
    resetMocks();
    const built = await buildServer({
      withUserValidator: false,
      withServiceValidator: true,
      withOauthPublicUrl: true,
    });
    try {
      validateEntraTokenExplainMock.mockResolvedValueOnce({
        ok: false,
        reason: 'invalid_token',
      });
      const res = await fetch(`${built.url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
        body: '{}',
      });
      expect(res.status).toBe(401);
      const challenge = res.headers.get('www-authenticate');
      expect(challenge).toContain('error="invalid_token"');
      // User validator must not be called when not configured.
      expect(validateUserTokenExplainMock).not.toHaveBeenCalled();
    } finally {
      built.server.close();
    }
  });
});
