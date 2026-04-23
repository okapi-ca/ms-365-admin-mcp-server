import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Express, Server } from 'http';
import crypto from 'crypto';
import { registerOAuthRoutes, type OAuthProxyOptions } from '../src/oauth-proxy.js';
import { MemoryStorage } from '../src/storage/memory-storage.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function sha256(input: string): string {
  return base64url(crypto.createHash('sha256').update(input).digest());
}

async function buildServer(storage: MemoryStorage): Promise<{ url: string; server: Server }> {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  const options: OAuthProxyOptions = {
    publicUrl: 'https://mcp.example.com',
    tenantId: TENANT,
    clientId: CLIENT_ID,
    clientSecret: 'upstream-entra-secret',
    scopes: ['openid', 'profile', 'email', 'offline_access', `api://${CLIENT_ID}/access_as_user`],
    enableDynamicRegistration: true,
    storage,
  };
  registerOAuthRoutes(app as Express, options);

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve({ url: `http://127.0.0.1:${addr.port}`, server });
      }
    });
  });
}

let storage: MemoryStorage;
let baseUrl: string;
let server: Server;
let fetchMock: ReturnType<typeof vi.fn>;
let realFetch: typeof fetch;

beforeAll(async () => {
  storage = new MemoryStorage();
  const built = await buildServer(storage);
  baseUrl = built.url;
  server = built.server;
  realFetch = globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  server.close();
});

beforeEach(() => {
  fetchMock = vi.fn();
  // SEC-F04b test harness: stub only the upstream Entra endpoint; route
  // traffic back to our test server hits the real fetch.
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [input] = args;
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('login.microsoftonline.com')) {
      return fetchMock(...args);
    }
    return realFetch(...args);
  }) as typeof fetch;
});

async function register(): Promise<{ clientId: string; clientSecret: string }> {
  const res = await realFetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://localhost:3000/cb'] }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    client_id: string;
    client_secret: string;
    token_endpoint_auth_method: string;
  };
  expect(body.token_endpoint_auth_method).toBe('client_secret_post');
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

describe('SEC-F04b /register (DCR) — confidential client issuance', () => {
  it('returns a client_id and a client_secret, and stores a hash', async () => {
    const { clientId, clientSecret } = await register();
    expect(clientId).toMatch(/^mcp-client-/);
    expect(clientSecret.length).toBeGreaterThan(20);

    const stored = await storage.getClient(clientId);
    expect(stored).not.toBeNull();
    expect(stored?.clientSecretHash).not.toBe(clientSecret);
    expect(stored?.clientSecretHash).toHaveLength(64);
  });
});

describe('SEC-F04b /authorize — unknown client_id rejected', () => {
  it('rejects client_id that was not registered via DCR', async () => {
    const res = await realFetch(
      `${baseUrl}/authorize?client_id=unknown&redirect_uri=http%3A%2F%2Flocalhost%2Fcb&code_challenge=xyz`,
      { redirect: 'manual' }
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_client');
  });

  it('accepts a DCR-registered client and redirects to Entra', async () => {
    const { clientId } = await register();
    const verifier = base64url(crypto.randomBytes(64));
    const challenge = sha256(verifier);
    const res = await realFetch(
      `${baseUrl}/authorize?client_id=${clientId}&redirect_uri=http%3A%2F%2Flocalhost%2Fcb&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: 'manual' }
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('login.microsoftonline.com');
  });

  it('injects offline_access into the upstream scope when the client omits it', async () => {
    const { clientId } = await register();
    const verifier = base64url(crypto.randomBytes(64));
    const challenge = sha256(verifier);
    const clientScope = 'openid profile email';
    const res = await realFetch(
      `${baseUrl}/authorize?client_id=${clientId}&redirect_uri=http%3A%2F%2Flocalhost%2Fcb&code_challenge=${challenge}&code_challenge_method=S256&scope=${encodeURIComponent(clientScope)}`,
      { redirect: 'manual' }
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    const upstream = new URL(location);
    const upstreamScope = upstream.searchParams.get('scope')!.split(' ');
    expect(upstreamScope).toContain('offline_access');
    expect(upstreamScope).toContain('openid');
    expect(upstreamScope).toContain('profile');
    expect(upstreamScope).toContain('email');
  });

  it('preserves offline_access once and does not duplicate when client already sends it', async () => {
    const { clientId } = await register();
    const verifier = base64url(crypto.randomBytes(64));
    const challenge = sha256(verifier);
    const clientScope = 'openid offline_access profile';
    const res = await realFetch(
      `${baseUrl}/authorize?client_id=${clientId}&redirect_uri=http%3A%2F%2Flocalhost%2Fcb&code_challenge=${challenge}&code_challenge_method=S256&scope=${encodeURIComponent(clientScope)}`,
      { redirect: 'manual' }
    );
    expect(res.status).toBe(302);
    const upstream = new URL(res.headers.get('location')!);
    const upstreamScope = upstream.searchParams.get('scope')!.split(' ');
    const offlineCount = upstreamScope.filter((s) => s === 'offline_access').length;
    expect(offlineCount).toBe(1);
  });

  it('forces prompt=select_account on the upstream authorize URL', async () => {
    const { clientId } = await register();
    const verifier = base64url(crypto.randomBytes(64));
    const challenge = sha256(verifier);
    const res = await realFetch(
      `${baseUrl}/authorize?client_id=${clientId}&redirect_uri=http%3A%2F%2Flocalhost%2Fcb&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: 'manual' }
    );
    expect(res.status).toBe(302);
    const upstream = new URL(res.headers.get('location')!);
    expect(upstream.searchParams.get('prompt')).toBe('select_account');
  });
});

describe('SEC-F04b /token — client authentication required', () => {
  it('rejects refresh_token grant with no client credentials', async () => {
    const res = await realFetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'stolen-rt' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_client');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects refresh_token grant with wrong client_secret', async () => {
    const { clientId } = await register();
    const res = await realFetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'stolen-rt',
        client_id: clientId,
        client_secret: 'wrong-secret',
      }),
    });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts refresh_token grant with valid credentials and forwards to Entra', async () => {
    const { clientId, clientSecret } = await register();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'new-at', refresh_token: 'new-rt' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const res = await realFetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'legit-rt',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { access_token: string };
    expect(body.access_token).toBe('new-at');
  });

  it('accepts Basic auth (client_secret_basic) as an alternative to body auth', async () => {
    const { clientId, clientSecret } = await register();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at' }), { status: 200 })
    );
    const basic = Buffer.from(
      `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`
    ).toString('base64');
    const res = await realFetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'rt' }),
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('SEC-F04b /token authorization_code — PKCE client_id binding', () => {
  it('rejects code redemption under a different client_id than /authorize used', async () => {
    const clientA = await register();
    const clientB = await register();
    const verifier = base64url(crypto.randomBytes(64));
    const challenge = sha256(verifier);

    // Client A starts the flow
    await realFetch(
      `${baseUrl}/authorize?client_id=${clientA.clientId}&redirect_uri=http%3A%2F%2Flocalhost%2Fcb&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: 'manual' }
    );

    // Client B tries to redeem a code with A's PKCE verifier
    const res = await realFetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'stolen-code',
        code_verifier: verifier,
        redirect_uri: 'http://localhost/cb',
        client_id: clientB.clientId,
        client_secret: clientB.clientSecret,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_grant');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('SEC-F04b oauth-mode startup — refuses when DCR is disabled', () => {
  it('throws when enableDynamicRegistration is false', () => {
    const app = express();
    expect(() =>
      registerOAuthRoutes(app as Express, {
        publicUrl: 'https://mcp.example.com',
        tenantId: TENANT,
        clientId: CLIENT_ID,
        clientSecret: 'x',
        scopes: [],
        enableDynamicRegistration: false,
        storage: new MemoryStorage(),
      })
    ).toThrow(/Dynamic Client Registration/);
  });
});

describe('RFC 8628 device_code flow — metadata advertises endpoint and grant', () => {
  it('exposes device_authorization_endpoint and the device_code grant in metadata', async () => {
    const res = await realFetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as {
      device_authorization_endpoint: string;
      grant_types_supported: string[];
    };
    expect(meta.device_authorization_endpoint).toBe('https://mcp.example.com/devicecode');
    expect(meta.grant_types_supported).toContain('urn:ietf:params:oauth:grant-type:device_code');
    expect(meta.grant_types_supported).toContain('authorization_code');
    expect(meta.grant_types_supported).toContain('refresh_token');
  });
});

describe('RFC 8628 /devicecode — client authentication required', () => {
  it('rejects a request with no client credentials', async () => {
    const res = await realFetch(`${baseUrl}/devicecode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_client');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a request for an unknown client_id', async () => {
    const res = await realFetch(`${baseUrl}/devicecode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'mcp-client-does-not-exist',
        client_secret: 'whatever',
      }),
    });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a request with a wrong client_secret', async () => {
    const { clientId } = await register();
    const res = await realFetch(`${baseUrl}/devicecode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: 'wrong' }),
    });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards an authenticated request to Entra devicecode endpoint', async () => {
    const { clientId, clientSecret } = await register();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          device_code: 'entra-device-code',
          user_code: 'ABCD-1234',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900,
          interval: 5,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const res = await realFetch(`${baseUrl}/devicecode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user_code: string; verification_uri: string };
    expect(body.user_code).toBe('ABCD-1234');
    expect(body.verification_uri).toBe('https://microsoft.com/devicelogin');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(calledUrl).toContain('login.microsoftonline.com');
    expect(calledUrl).toContain('/oauth2/v2.0/devicecode');
    const forwardedScope = new URLSearchParams(calledInit.body).get('scope') ?? '';
    expect(forwardedScope).toContain('offline_access');
  });

  it('preserves offline_access without duplicating when the client sends it', async () => {
    const { clientId, clientSecret } = await register();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ device_code: 'x' }), { status: 200 })
    );
    const res = await realFetch(`${baseUrl}/devicecode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'openid offline_access profile',
      }),
    });
    expect(res.status).toBe(200);
    const [, calledInit] = fetchMock.mock.calls[0] as [string, { body: string }];
    const forwardedScope = (new URLSearchParams(calledInit.body).get('scope') ?? '').split(' ');
    expect(forwardedScope.filter((s) => s === 'offline_access')).toHaveLength(1);
  });

  it('relays Entra error responses verbatim (e.g. upstream 400)', async () => {
    const { clientId, clientSecret } = await register();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'invalid_scope', error_description: 'Requested scope is invalid' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const res = await realFetch(`${baseUrl}/devicecode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_scope');
  });
});

describe('RFC 8628 /token device_code grant', () => {
  const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

  it('rejects device_code grant with no client credentials', async () => {
    const res = await realFetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: GRANT, device_code: 'x' }),
    });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects device_code grant with missing device_code parameter', async () => {
    const { clientId, clientSecret } = await register();
    const res = await realFetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: GRANT,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards a valid device_code grant to Entra and returns the token bundle', async () => {
    const { clientId, clientSecret } = await register();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const res = await realFetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: GRANT,
        device_code: 'entra-device-code',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; refresh_token: string };
    expect(body.access_token).toBe('at');
    expect(body.refresh_token).toBe('rt');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(calledUrl).toContain('/oauth2/v2.0/token');
    const forwarded = new URLSearchParams(calledInit.body);
    expect(forwarded.get('grant_type')).toBe(GRANT);
    expect(forwarded.get('device_code')).toBe('entra-device-code');
  });

  it('relays authorization_pending from Entra verbatim so the client can poll', async () => {
    const { clientId, clientSecret } = await register();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'authorization_pending',
          error_description: 'User has not finished authenticating',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const res = await realFetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: GRANT,
        device_code: 'pending-code',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('authorization_pending');
  });
});
