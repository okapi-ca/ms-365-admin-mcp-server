import { describe, it, expect } from 'vitest';
import { withStaleKeyFallback } from '../src/jwks-stale-cache.js';

describe('withStaleKeyFallback', () => {
  it('stores the key under kid on success and returns it', async () => {
    const cache = new Map<string, string>();
    const key = await withStaleKeyFallback('kid-1', async () => 'PEM-FRESH', cache);
    expect(key).toBe('PEM-FRESH');
    expect(cache.get('kid-1')).toBe('PEM-FRESH');
  });

  it('serves the stale cached key when the fetch fails', async () => {
    const cache = new Map<string, string>([['kid-1', 'PEM-STALE']]);
    const key = await withStaleKeyFallback(
      'kid-1',
      async () => {
        throw new Error('JWKS endpoint unreachable');
      },
      cache
    );
    expect(key).toBe('PEM-STALE');
  });

  it('rethrows when the fetch fails and no stale entry is cached for the kid', async () => {
    const cache = new Map<string, string>();
    await expect(
      withStaleKeyFallback(
        'kid-unknown',
        async () => {
          throw new Error('JWKS endpoint unreachable');
        },
        cache
      )
    ).rejects.toThrow('JWKS endpoint unreachable');
  });

  it('rethrows when kid is undefined even if the cache has entries', async () => {
    const cache = new Map<string, string>([['kid-1', 'PEM-STALE']]);
    await expect(
      withStaleKeyFallback(
        undefined,
        async () => {
          throw new Error('JWKS endpoint unreachable');
        },
        cache
      )
    ).rejects.toThrow('JWKS endpoint unreachable');
  });

  it('overwrites stale cache when a newer successful fetch returns a different PEM', async () => {
    const cache = new Map<string, string>([['kid-1', 'PEM-OLD']]);
    const key = await withStaleKeyFallback('kid-1', async () => 'PEM-NEW', cache);
    expect(key).toBe('PEM-NEW');
    expect(cache.get('kid-1')).toBe('PEM-NEW');
  });
});
