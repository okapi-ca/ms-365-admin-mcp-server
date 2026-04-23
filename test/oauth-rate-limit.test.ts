import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Express, Server } from 'http';
import { registerOAuthRoutes, type OAuthProxyOptions } from '../src/oauth-proxy.js';
import { registerOAuthRateLimiters } from '../src/oauth-rate-limiters.js';
import { MemoryStorage } from '../src/storage/memory-storage.js';

// Regression test for the v0.6.1 fix:
// v0.6.0 shipped a shared tight rate limiter (10 req/min) on /token that
// killed RFC 8628 device_code polling before MFA could complete — Marc's
// admin bootstrap hit 429 at ~50 s on prod 2026-04-23. The fix splits the
// limiter by grant_type so device_code (60/min) doesn't share the counter
// with authorization_code / refresh_token (10/min).

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

async function buildServer(): Promise<{ url: string; server: Server }> {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  // Apply the rate limiters exactly the way startHttpServer does, then
  // register the OAuth routes on top.
  registerOAuthRateLimiters(app as Express);
  const options: OAuthProxyOptions = {
    publicUrl: 'https://mcp.example.com',
    tenantId: TENANT,
    clientId: CLIENT_ID,
    clientSecret: 'upstream-entra-secret',
    scopes: ['openid', 'profile', 'email', 'offline_access', `api://${CLIENT_ID}/access_as_user`],
    enableDynamicRegistration: true,
    storage: new MemoryStorage(),
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

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  const built = await buildServer();
  baseUrl = built.url;
  server = built.server;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  // Each test gets a fresh window by recreating the server is heavy — we
  // rely on the fact that express-rate-limit uses an in-process store that
  // we reset between tests by restarting the server. For most tests the
  // counters reset naturally because different grant_types land on
  // different limiters, and the test count stays below each limit's cap.
});

async function postToken(body: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
}

describe('v0.6.1 /token rate limiter — split by grant_type', () => {
  // The key correctness claim: a device_code poll cadence that USED to
  // fail after 10 requests now succeeds for at least 15. We use a fresh
  // server for this test to start from an empty limiter window.
  it('allows 20 device_code polls without hitting 429 (was broken at 11 in v0.6.0)', async () => {
    // Fresh server so the limiter window starts empty.
    const { url: freshUrl, server: freshServer } = await buildServer();
    try {
      const responses: number[] = [];
      for (let i = 0; i < 20; i++) {
        const res = await fetch(`${freshUrl}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: DEVICE_CODE_GRANT,
            device_code: `poll-${i}`,
            client_id: 'fake',
            client_secret: 'fake',
          }).toString(),
        });
        responses.push(res.status);
        // We don't care about the response body — the limiter decides first.
        // Expected status is 401 (invalid_client) since we're using fake
        // credentials; the key is that none should be 429.
      }
      const rateLimited = responses.filter((s) => s === 429);
      expect(rateLimited).toHaveLength(0);
      // All should be 401 invalid_client — the device_code limiter let them
      // through and the downstream proxy rejected unknown creds.
      expect(responses.every((s) => s === 401)).toBe(true);
    } finally {
      freshServer.close();
    }
  });

  it('still rate-limits refresh_token after 10 requests (existing blast radius preserved)', async () => {
    const { url: freshUrl, server: freshServer } = await buildServer();
    try {
      const responses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await fetch(`${freshUrl}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: `stolen-${i}`,
            client_id: 'fake',
            client_secret: 'fake',
          }).toString(),
        });
        responses.push(res.status);
      }
      // First 10 should get past the limiter (returning 401 invalid_client),
      // subsequent ones should hit 429.
      const rateLimited = responses.filter((s) => s === 429);
      expect(rateLimited.length).toBeGreaterThanOrEqual(1);
      expect(rateLimited.length).toBeLessThanOrEqual(2);
      // The first response must not be 429 — the limiter should let the
      // first request through regardless.
      expect(responses[0]).toBe(401);
    } finally {
      freshServer.close();
    }
  });

  it('still rate-limits authorization_code after 10 requests (existing blast radius preserved)', async () => {
    const { url: freshUrl, server: freshServer } = await buildServer();
    try {
      const responses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await fetch(`${freshUrl}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: `stolen-${i}`,
            code_verifier: 'x',
            redirect_uri: 'http://localhost/cb',
            client_id: 'fake',
            client_secret: 'fake',
          }).toString(),
        });
        responses.push(res.status);
      }
      expect(responses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    } finally {
      freshServer.close();
    }
  });

  it('routes mixed grants to independent counters (device_code polls while refresh_token is throttled)', async () => {
    const { url: freshUrl, server: freshServer } = await buildServer();
    try {
      // Burn through the refresh_token limiter: 11 calls, last one should 429.
      for (let i = 0; i < 11; i++) {
        await fetch(`${freshUrl}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: 'x',
            client_id: 'fake',
            client_secret: 'fake',
          }).toString(),
        });
      }
      // Confirm refresh_token is now rate-limited.
      const rtRes = await fetch(`${freshUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: 'x',
          client_id: 'fake',
          client_secret: 'fake',
        }).toString(),
      });
      expect(rtRes.status).toBe(429);

      // But a device_code poll on the SAME connection (same IP) should
      // still succeed — independent limiter.
      const dcRes = await fetch(`${freshUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: DEVICE_CODE_GRANT,
          device_code: 'x',
          client_id: 'fake',
          client_secret: 'fake',
        }).toString(),
      });
      expect(dcRes.status).toBe(401); // invalid_client, NOT 429
    } finally {
      freshServer.close();
    }
  });

  it('falls back to tight limiter for unknown / missing grant_type (safe default)', async () => {
    const { url: freshUrl, server: freshServer } = await buildServer();
    try {
      const responses: number[] = [];
      for (let i = 0; i < 12; i++) {
        // No grant_type at all — must get routed to the tight limiter.
        const res = await fetch(`${freshUrl}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: '',
        });
        responses.push(res.status);
      }
      expect(responses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    } finally {
      freshServer.close();
    }
  });
});

describe('v0.6.1 /devicecode rate limiter — unchanged (still tight)', () => {
  it('rate-limits /devicecode after 10 requests (one-shot per bootstrap)', async () => {
    const { url: freshUrl, server: freshServer } = await buildServer();
    try {
      const responses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await fetch(`${freshUrl}/devicecode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: 'fake', client_secret: 'fake' }).toString(),
        });
        responses.push(res.status);
      }
      expect(responses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    } finally {
      freshServer.close();
    }
  });
});
