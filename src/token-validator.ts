import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import logger from './logger.js';
import { withStaleKeyFallback } from './jwks-stale-cache.js';

export interface TokenValidatorOptions {
  tenantId: string;
  allowedClientIds: string[];
  expectedAudience?: string;
}

interface EntraTokenPayload {
  iss?: string;
  aud?: string;
  exp?: number;
  appid?: string;
  azp?: string;
  tid?: string;
  // App Role assignments granted to the calling SP. Present when one or more
  // app roles defined on this app's manifest are assigned to the client
  // service principal via Enterprise Apps → Users and groups.
  roles?: string[];
}

export interface ServiceTokenClaims {
  clientId: string;
  roles: string[];
}

const jwksClients = new Map<string, jwksRsa.JwksClient>();
// SEC-F08: per-tenant stale-while-revalidate cache of PEM public keys.
const staleKeyCaches = new Map<string, Map<string, string>>();

function getJwksClient(tenantId: string): jwksRsa.JwksClient {
  let client = jwksClients.get(tenantId);
  if (!client) {
    client = jwksRsa({
      jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
      cache: true,
      // SEC-F08: 24h in-library cache; the stale-key fallback below catches
      // outages that outlast it. Entra only activates newly-published keys
      // after advertising them well in advance, so a longer TTL is safe.
      cacheMaxAge: 24 * 60 * 60 * 1000,
      rateLimit: true,
    });
    jwksClients.set(tenantId, client);
  }
  return client;
}

function getStaleKeyCache(tenantId: string): Map<string, string> {
  let cache = staleKeyCaches.get(tenantId);
  if (!cache) {
    cache = new Map<string, string>();
    staleKeyCaches.set(tenantId, cache);
  }
  return cache;
}

function fetchSigningKey(client: jwksRsa.JwksClient, kid: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.getSigningKey(kid, (err, key) => {
      if (err) {
        reject(err);
        return;
      }
      if (!key) {
        reject(new Error('No signing key found'));
        return;
      }
      resolve(key.getPublicKey());
    });
  });
}

function getSigningKey(
  tenantId: string,
  client: jwksRsa.JwksClient,
  header: jwt.JwtHeader
): Promise<string> {
  if (!header.kid) return Promise.reject(new Error('JWT header missing kid'));
  const kid = header.kid;
  return withStaleKeyFallback(kid, () => fetchSigningKey(client, kid), getStaleKeyCache(tenantId));
}

/**
 * Result of `validateEntraTokenExplain`. Service tokens (client_credentials)
 * do not carry user scopes, so every failure mode reduces to `invalid_token`
 * — there is no `insufficient_scope` path here. Kept as a tagged union for
 * symmetry with `validateUserTokenExplain`.
 *
 * On success, `claims.roles` carries any App Role assignments granted to the
 * calling service principal. Consumers (e.g. per-caller write gating in
 * `server.ts`) check membership against `Tools.Write` etc. — absence of a
 * role is NOT an authentication failure here, only an authorization signal
 * surfaced to downstream tool registration.
 */
export type ValidateEntraTokenResult =
  { ok: true; claims: ServiceTokenClaims } | { ok: false; reason: 'invalid_token' };

export async function validateEntraTokenExplain(
  token: string,
  options: TokenValidatorOptions
): Promise<ValidateEntraTokenResult> {
  try {
    const client = getJwksClient(options.tenantId);

    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string') {
      logger.warn('Token could not be decoded');
      return { ok: false, reason: 'invalid_token' };
    }

    const publicKey = await getSigningKey(options.tenantId, client, decoded.header);

    const payload = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: `https://login.microsoftonline.com/${options.tenantId}/v2.0`,
      clockTolerance: 30,
    }) as EntraTokenPayload;

    // SEC-02: Verify audience
    if (options.expectedAudience) {
      if (payload.aud !== options.expectedAudience) {
        logger.warn('Token audience mismatch');
        return { ok: false, reason: 'invalid_token' };
      }
    }

    // Verify tenant ID from token payload
    if (payload.tid && payload.tid !== options.tenantId) {
      logger.warn('Token tenant ID mismatch');
      return { ok: false, reason: 'invalid_token' };
    }

    // Verify client ID is in the allowed list
    const clientId = payload.appid || payload.azp;
    if (!clientId || !options.allowedClientIds.includes(clientId)) {
      logger.warn('Token client ID not in allowed list');
      return { ok: false, reason: 'invalid_token' };
    }

    return {
      ok: true,
      claims: {
        clientId,
        roles: Array.isArray(payload.roles) ? payload.roles : [],
      },
    };
  } catch (error) {
    // Signature, expiry (TokenExpiredError), JWKS lookup, decode — all collapse
    // to RFC 6750 `invalid_token` from the wire's point of view.
    logger.error(`Token validation failed: ${(error as Error).message}`);
    return { ok: false, reason: 'invalid_token' };
  }
}

/**
 * Backwards-compatible wrapper. Prefer `validateEntraTokenExplain` in new
 * callers so the failure mode can be surfaced as an HTTP status.
 */
export async function validateEntraToken(
  token: string,
  options: TokenValidatorOptions
): Promise<boolean> {
  const result = await validateEntraTokenExplain(token, options);
  return result.ok;
}
