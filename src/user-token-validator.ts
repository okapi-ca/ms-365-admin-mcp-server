import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import logger from './logger.js';
import { withStaleKeyFallback } from './jwks-stale-cache.js';
import {
  authorizeUserClaimsExplain,
  type AuthorizeUserClaimsResult,
  type UserTokenClaims,
  type UserTokenPayload,
  type UserTokenValidatorOptions,
} from './user-token-authorization.js';

export { authorizeUserClaims, authorizeUserClaimsExplain } from './user-token-authorization.js';
export type {
  AuthorizationFailureReason,
  AuthorizeUserClaimsResult,
  UserTokenClaims,
  UserTokenPayload,
  UserTokenValidatorOptions,
} from './user-token-authorization.js';

export type ValidateUserTokenResult = AuthorizeUserClaimsResult;

const jwksClients = new Map<string, jwksRsa.JwksClient>();
// SEC-F08: per-tenant stale-while-revalidate cache of PEM public keys.
const staleKeyCaches = new Map<string, Map<string, string>>();

function getJwksClient(tenantId: string): jwksRsa.JwksClient {
  let client = jwksClients.get(tenantId);
  if (!client) {
    client = jwksRsa({
      jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
      cache: true,
      // SEC-F08: 24h in-library cache; stale-key fallback catches longer outages.
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
      if (err) return reject(err);
      if (!key) return reject(new Error('No signing key found'));
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
 * Verify a user token and run authorization checks. Returns a structured
 * result so the HTTP layer can map failures to the correct RFC 6750 status:
 * `invalid_token` (signature, JWKS, expiry, audience, allowlist) → 401,
 * `insufficient_scope` (token valid but `scp` missing a required entry) → 403.
 */
export async function validateUserTokenExplain(
  token: string,
  options: UserTokenValidatorOptions
): Promise<ValidateUserTokenResult> {
  try {
    const client = getJwksClient(options.tenantId);

    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string') {
      logger.warn('User token could not be decoded');
      return { ok: false, reason: 'invalid_token' };
    }

    const publicKey = await getSigningKey(options.tenantId, client, decoded.header);

    const payload = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: [
        `https://login.microsoftonline.com/${options.tenantId}/v2.0`,
        `https://sts.windows.net/${options.tenantId}/`,
      ],
      clockTolerance: 30,
    }) as UserTokenPayload;

    return authorizeUserClaimsExplain(payload, options);
  } catch (error) {
    // Signature, expiry, JWKS, decode failures all collapse to invalid_token.
    // jsonwebtoken throws TokenExpiredError, JsonWebTokenError, NotBeforeError —
    // all are RFC 6750 invalid_token from the wire's point of view.
    logger.error(`User token validation failed: ${(error as Error).message}`);
    return { ok: false, reason: 'invalid_token' };
  }
}

/**
 * Backwards-compatible wrapper. Returns claims on success or `null` on any
 * failure. Prefer `validateUserTokenExplain` in new callers.
 */
export async function validateUserToken(
  token: string,
  options: UserTokenValidatorOptions
): Promise<UserTokenClaims | null> {
  const result = await validateUserTokenExplain(token, options);
  return result.ok ? result.claims : null;
}
