import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import GraphClient, { DEFAULT_ACCEPT_LANGUAGE } from '../src/graph-client.js';
import type { AppSecrets } from '../src/secrets.js';

const secrets: AppSecrets = {
  clientId: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  clientSecret: 'not-a-real-secret',
  cloudType: 'global',
};

function newClient(): GraphClient {
  return new GraphClient(async () => 'fake-token', secrets);
}

/** Captures the headers of the single fetch a graphRequest performs. */
function captureFetchHeaders(): { get: (name: string) => string | undefined } {
  const captured = new Headers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { headers?: Record<string, string> }) => {
      new Headers(init.headers).forEach((value, key) => captured.set(key, value));
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    })
  );
  return { get: (name) => captured.get(name) ?? undefined };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BUG-PIM: Accept-Language on Graph requests', () => {
  it('sends an explicit, valid Accept-Language on every request', async () => {
    const headers = captureFetchHeaders();
    await newClient().graphRequest('/roleManagement/directory/roleAssignmentScheduleInstances');

    expect(headers.get('accept-language')).toBe(DEFAULT_ACCEPT_LANGUAGE);
    // The wildcard is precisely the value that made Graph's PIM backends throw
    // CultureNotFoundException — assert it never reaches the wire.
    expect(headers.get('accept-language')).not.toBe('*');
  });

  it('lets a per-call header override the default', async () => {
    const headers = captureFetchHeaders();
    await newClient().graphRequest('/users', { headers: { 'Accept-Language': 'fr-CA' } });

    expect(headers.get('accept-language')).toBe('fr-CA');
  });

  it('keeps sending it on write requests', async () => {
    const headers = captureFetchHeaders();
    await newClient().graphRequest('/groups/g/owners/$ref', {
      method: 'POST',
      body: JSON.stringify({ '@odata.id': 'https://graph.microsoft.com/v1.0/users/u' }),
    });

    expect(headers.get('accept-language')).toBe(DEFAULT_ACCEPT_LANGUAGE);
  });

  it("documents why the header is mandatory: Node's fetch supplies no usable value", async () => {
    // Root cause, pinned as a test: undici appends the Fetch-spec default
    // `Accept-Language: *` when the header is absent. `*` is not a culture
    // identifier, so Graph's PIM / identityGovernance routes returned HTTP 400.
    // Should a future Node drop the default outright, the received value becomes
    // undefined — which is equally unusable, and the explicit header still earns
    // its place. Either outcome keeps this assertion true; a Node that started
    // sending a *valid* tag is the only thing that would fail here, and that
    // would be worth knowing.
    const received = await new Promise<string | undefined>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        res.end('{}');
        server.close();
        resolve(req.headers['accept-language']);
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        fetch(`http://127.0.0.1:${port}/`, {
          headers: { Authorization: 'Bearer fake-token', 'Content-Type': 'application/json' },
        }).catch(reject);
      });
    });

    expect(received === undefined || received === '*').toBe(true);
  });
});
