import crypto from 'crypto';
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
  // SEC-F08 (SEC-004): when true, log lines emit a stable SHA-256 prefix of the
  // UPN instead of the plaintext value. Investigation correlation is preserved
  // (the same UPN always hashes to the same prefix) while the log stream is
  // safe to ship to a SIEM / forwarder under PIPEDA / RGPD / Loi 25 without a
  // separate Data Processing Agreement covering work-email PII. The Entra
  // `oid` (a non-PII GUID) remains in plaintext so operators can still pivot
  // to a user via the directory.
  redactUpn?: boolean;
}

/**
 * SEC-F08 (SEC-004): format a UPN-like value for emission to logs.
 *
 * Returns the value verbatim when `redact` is false (default). When true,
 * returns a 16-char prefix of the SHA-256 hash, prefixed with `sha256:` so
 * forwarders and SIEM rules can recognise the format. The hash is keyed only
 * on the value itself (no salt) — the goal is non-reversibility for casual
 * log readers, not cryptographic resistance to an attacker who already has
 * tenant directory access.
 */
export function formatUpnForLog(value: string | undefined, redact: boolean | undefined): string {
  if (!value) return '<none>';
  if (!redact) return value;
  return 'sha256:' + crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

export interface UserTokenClaims {
  oid: string;
  upn?: string;
  name?: string;
  appid?: string;
  // App Role assignments granted to this user (or to a group they belong to)
  // on this app registration. Drives per-caller write gating in `server.ts`.
  // Empty array when no roles are assigned — never undefined.
  roles: string[];
}

/**
 * Structured outcome of `authorizeUserClaimsExplain`. Distinguishes
 * `invalid_token` (signature/audience/issuer/expiry/missing-claim/allowlist
 * failures — the bearer is unauthenticated as far as RFC 6750 §3.1 is
 * concerned) from `insufficient_scope` (token is otherwise valid but lacks a
 * required `scp` claim entry — RFC 6750 §3.1 §insufficient_scope).
 *
 * mcp-remote and other RFC-compliant clients only attempt a refresh on 401
 * `invalid_token`; on 403 `insufficient_scope` they correctly stop. Mapping
 * the wrong reason to the wrong HTTP status causes infinite reconnect loops
 * when the access_token simply expired.
 */
export type AuthorizationFailureReason = 'invalid_token' | 'insufficient_scope';

export type AuthorizeUserClaimsResult =
  { ok: true; claims: UserTokenClaims } | { ok: false; reason: AuthorizationFailureReason };

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
  roles?: string[];
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
 *
 * Returns a structured result so callers (HTTP layer) can map RFC 6750 §3.1
 * error codes to the correct HTTP status: `invalid_token` → 401,
 * `insufficient_scope` → 403. See `AuthorizeUserClaimsResult` for rationale.
 */
export function authorizeUserClaimsExplain(
  payload: UserTokenPayload,
  options: UserTokenValidatorOptions
): AuthorizeUserClaimsResult {
  if (payload.tid && payload.tid !== options.tenantId) {
    logger.warn(`User token tenant mismatch: tid=${payload.tid}, expected=${options.tenantId}`);
    return { ok: false, reason: 'invalid_token' };
  }

  if (!audienceMatches(payload.aud, options.expectedAudiences)) {
    logger.warn(
      `User token audience not in expected list: aud=${JSON.stringify(payload.aud)}, expected=${JSON.stringify(options.expectedAudiences)}`
    );
    return { ok: false, reason: 'invalid_token' };
  }

  const oid = payload.oid;
  if (!oid) {
    logger.warn('User token missing oid claim');
    return { ok: false, reason: 'invalid_token' };
  }

  // SEC-F01: fail-closed when no per-user allowlist is configured.
  // Without this guard, any tenant user who obtains a token with the expected
  // audience would gain the server's full app-permission capability.
  const upnForLog = formatUpnForLog(payload.upn || payload.preferred_username, options.redactUpn);
  if (options.authorizedUserOids.length === 0) {
    if (!options.allowAnyTenantUser) {
      logger.warn(
        `User ${upnForLog} (oid ${oid}) rejected: no --authorized-users allowlist configured and --allow-any-tenant-user not set`
      );
      return { ok: false, reason: 'invalid_token' };
    }
  } else if (!options.authorizedUserOids.includes(oid)) {
    logger.warn(`User oid ${oid} (${upnForLog}) not in authorized-users allowlist`);
    return { ok: false, reason: 'invalid_token' };
  }

  // SEC-F03: enforce required scopes (e.g. access_as_user) on the `scp` claim.
  // This is the one case where the token is "valid" (signed, audience OK,
  // identity OK) but the principal lacks the required scope — RFC 6750
  // `insufficient_scope` / HTTP 403, distinct from `invalid_token` / 401.
  if (options.requiredScopes.length > 0) {
    const tokenScopes = parseTokenScopes(payload.scp);
    const missing = options.requiredScopes.filter((s) => !tokenScopes.includes(s));
    if (missing.length > 0) {
      logger.warn(
        `User token missing required scope(s): ${missing.join(', ')}; token scp=${payload.scp ?? '<none>'}`
      );
      return { ok: false, reason: 'insufficient_scope' };
    }
  }

  return {
    ok: true,
    claims: {
      oid,
      upn: payload.upn || payload.preferred_username,
      name: payload.name,
      appid: payload.appid || payload.azp,
      roles: Array.isArray(payload.roles) ? payload.roles : [],
    },
  };
}

/**
 * Backwards-compatible wrapper around `authorizeUserClaimsExplain`. Returns
 * the claims on success or `null` on any rejection. Prefer the explain variant
 * in new callers so the failure mode can be surfaced as an HTTP status.
 */
export function authorizeUserClaims(
  payload: UserTokenPayload,
  options: UserTokenValidatorOptions
): UserTokenClaims | null {
  const result = authorizeUserClaimsExplain(payload, options);
  return result.ok ? result.claims : null;
}
