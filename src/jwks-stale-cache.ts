import logger from './logger.js';

/**
 * SEC-F08: stale-while-revalidate wrapper around JWKS key retrieval.
 *
 * On a successful fetch, the PEM is stored under its `kid`. On a failed fetch,
 * if we have previously cached a key for the same `kid`, we return it and log
 * a warning instead of failing token validation outright. This survives brief
 * Entra JWKS outages without opening any new attack surface — the stale key
 * was already trusted, its signatures are still valid, and only its freshness
 * is at issue. Truly rotated keys fail at the fetch AND have no stale entry,
 * so validation fails closed.
 *
 * Exposed as a pure function for unit testing. Each validator keeps its own
 * cache `Map` so eviction policies can differ per caller if needed.
 */
export async function withStaleKeyFallback(
  kid: string | undefined,
  fetchKey: () => Promise<string>,
  staleCache: Map<string, string>
): Promise<string> {
  try {
    const key = await fetchKey();
    if (kid) staleCache.set(kid, key);
    return key;
  } catch (err) {
    if (kid && staleCache.has(kid)) {
      logger.warn(
        `JWKS fetch failed for kid=${kid}; serving stale cached key (${(err as Error).message})`
      );
      return staleCache.get(kid) as string;
    }
    throw err;
  }
}
