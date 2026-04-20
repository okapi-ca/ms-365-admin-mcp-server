import { describe, it, expect } from 'vitest';
import { MemoryStorage } from '../src/storage/memory-storage.js';
import { hashClientSecret, verifyClientSecret } from '../src/storage/oauth-storage.js';

describe('MemoryStorage — PKCE bridge', () => {
  it('stores and consumes a PKCE entry (one-shot)', async () => {
    const store = new MemoryStorage();
    await store.savePkce({
      clientChallenge: 'abc',
      serverVerifier: 'verifier',
      redirectUri: 'http://localhost:3000/cb',
      clientId: 'mcp-client-1',
      expiresAt: Date.now() + 60_000,
    });

    const first = await store.consumePkce('abc');
    expect(first?.serverVerifier).toBe('verifier');

    const second = await store.consumePkce('abc');
    expect(second).toBeNull();
  });

  it('returns null for expired entries and removes them on consume', async () => {
    const store = new MemoryStorage();
    await store.savePkce({
      clientChallenge: 'stale',
      serverVerifier: 'v',
      redirectUri: 'http://localhost/cb',
      clientId: 'c',
      expiresAt: Date.now() - 1,
    });
    expect(await store.consumePkce('stale')).toBeNull();
  });

  it('returns null for unknown challenges', async () => {
    const store = new MemoryStorage();
    expect(await store.consumePkce('unknown')).toBeNull();
  });
});

describe('MemoryStorage — DCR clients', () => {
  it('round-trips a registered client', async () => {
    const store = new MemoryStorage();
    await store.saveClient({
      clientId: 'mcp-client-42',
      clientSecretHash: hashClientSecret('super-secret'),
      redirectUris: ['http://localhost:3000/cb'],
      createdAt: Date.now(),
    });
    const got = await store.getClient('mcp-client-42');
    expect(got?.clientId).toBe('mcp-client-42');
    expect(got?.redirectUris).toEqual(['http://localhost:3000/cb']);
  });

  it('returns null for unknown client_id', async () => {
    const store = new MemoryStorage();
    expect(await store.getClient('ghost')).toBeNull();
  });
});

describe('client_secret hashing', () => {
  it('produces a stable SHA-256 hex digest', () => {
    const h1 = hashClientSecret('abc');
    const h2 = hashClientSecret('abc');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it('verifyClientSecret accepts the correct secret', () => {
    const secret = 'my-random-32-byte-secret-value';
    const hash = hashClientSecret(secret);
    expect(verifyClientSecret(secret, hash)).toBe(true);
  });

  it('verifyClientSecret rejects the wrong secret', () => {
    const hash = hashClientSecret('correct');
    expect(verifyClientSecret('wrong', hash)).toBe(false);
  });

  it('verifyClientSecret rejects malformed hashes without throwing', () => {
    expect(verifyClientSecret('anything', 'tooshort')).toBe(false);
    expect(verifyClientSecret('anything', '')).toBe(false);
  });
});
