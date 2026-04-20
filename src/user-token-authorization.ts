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

export interface UserTokenPayload {
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
 * Pure function — no network, no JWT verification — so it is safe to import
 * from tests without pulling the JWKS / jose dependency chain.
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
