import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import logger from './logger.js';

export interface UserTokenValidatorOptions {
  tenantId: string;
  expectedAudiences: string[];
  authorizedUserOids: string[];
  // SEC-F01: explicit opt-in required when authorizedUserOids is empty.
  // Without this flag and an empty allowlist, all user tokens are rejected.
  allowAnyTenantUser: boolean;
  // SEC-F03: user tokens must contain every scope listed here in their `scp` claim.
  // Default is enforced at the caller (server.ts); an empty list disables the check.
  requiredScopes: string[];
}

export interface UserTokenClaims {
  oid: string;
  upn?: string;
  name?: string;
  appid?: string;
}

interface UserTokenPayload {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  oid?: string;
  upn?: string;
  preferred_username?: string;
  name?: string;
  tid?: string;
  appid?: string;
  azp?: string;
  scp?: string;
}

const jwksClients = new Map<string, jwksRsa.JwksClient>();

function getJwksClient(tenantId: string): jwksRsa.JwksClient {
  let client = jwksClients.get(tenantId);
  if (!client) {
    client = jwksRsa({
      jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
      cache: true,
      cacheMaxAge: 600_000,
      rateLimit: true,
    });
    jwksClients.set(tenantId, client);
  }
  return client;
}

function getSigningKey(client: jwksRsa.JwksClient, header: jwt.JwtHeader): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!header.kid) {
      reject(new Error('JWT header missing kid'));
      return;
    }
    client.getSigningKey(header.kid, (err, key) => {
      if (err) return reject(err);
      if (!key) return reject(new Error('No signing key found'));
      resolve(key.getPublicKey());
    });
  });
}

function audienceMatches(tokenAud: string | string[] | undefined, expected: string[]): boolean {
  if (!tokenAud || expected.length === 0) return false;
  const list = Array.isArray(tokenAud) ? tokenAud : [tokenAud];
  return list.some((a) => expected.includes(a));
}

function parseTokenScopes(scp: string | undefined): string[] {
  if (!scp) return [];
  return scp.split(' ').filter(Boolean);
}

/**
 * Post-signature-verification authorization checks on the user token payload.
 * Pure function — no network, no JWT verification. Exposed for unit testing.
 */
export function authorizeUserClaims(
  payload: UserTokenPayload,
  options: UserTokenValidatorOptions
): UserTokenClaims | null {
  if (payload.tid && payload.tid !== options.tenantId) {
    logger.warn(`User token tenant mismatch: tid=${payload.tid}, expected=${options.tenantId}`);
    return null;
  }

  if (!audienceMatches(payload.aud, options.expectedAudiences)) {
    logger.warn(
      `User token audience not in expected list: aud=${JSON.stringify(payload.aud)}, expected=${JSON.stringify(options.expectedAudiences)}`
    );
    return null;
  }

  const oid = payload.oid;
  if (!oid) {
    logger.warn('User token missing oid claim');
    return null;
  }

  // SEC-F01: fail-closed when no per-user allowlist is configured.
  // Without this guard, any tenant user who obtains a token with the expected
  // audience would gain the server's full app-permission capability.
  if (options.authorizedUserOids.length === 0) {
    if (!options.allowAnyTenantUser) {
      logger.warn(
        `User ${payload.upn || payload.preferred_username || oid} rejected: no --authorized-users allowlist configured and --allow-any-tenant-user not set`
      );
      return null;
    }
  } else if (!options.authorizedUserOids.includes(oid)) {
    logger.warn(
      `User oid ${oid} (${payload.upn || payload.preferred_username || 'no upn'}) not in authorized-users allowlist`
    );
    return null;
  }

  // SEC-F03: enforce required scopes (e.g. access_as_user) on the `scp` claim.
  if (options.requiredScopes.length > 0) {
    const tokenScopes = parseTokenScopes(payload.scp);
    const missing = options.requiredScopes.filter((s) => !tokenScopes.includes(s));
    if (missing.length > 0) {
      logger.warn(
        `User token missing required scope(s): ${missing.join(', ')}; token scp=${payload.scp ?? '<none>'}`
      );
      return null;
    }
  }

  return {
    oid,
    upn: payload.upn || payload.preferred_username,
    name: payload.name,
    appid: payload.appid || payload.azp,
  };
}

export async function validateUserToken(
  token: string,
  options: UserTokenValidatorOptions
): Promise<UserTokenClaims | null> {
  try {
    const client = getJwksClient(options.tenantId);

    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string') {
      logger.warn('User token could not be decoded');
      return null;
    }

    const publicKey = await getSigningKey(client, decoded.header);

    const payload = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: [
        `https://login.microsoftonline.com/${options.tenantId}/v2.0`,
        `https://sts.windows.net/${options.tenantId}/`,
      ],
      clockTolerance: 30,
    }) as UserTokenPayload;

    return authorizeUserClaims(payload, options);
  } catch (error) {
    logger.error(`User token validation failed: ${(error as Error).message}`);
    return null;
  }
}
