import { describe, it, expect } from 'vitest';
import {
  authorizeUserClaims,
  authorizeUserClaimsExplain,
  formatUpnForLog,
  type UserTokenValidatorOptions,
} from '../src/user-token-authorization.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OID_ALICE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OID_BOB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';

function baseOptions(
  overrides: Partial<UserTokenValidatorOptions> = {}
): UserTokenValidatorOptions {
  return {
    tenantId: TENANT,
    expectedAudiences: [CLIENT_ID, `api://${CLIENT_ID}`],
    authorizedUserOids: [],
    allowAnyTenantUser: false,
    requiredScopes: [],
    ...overrides,
  };
}

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tid: TENANT,
    aud: `api://${CLIENT_ID}`,
    oid: OID_ALICE,
    upn: 'alice@contoso.com',
    scp: 'access_as_user',
    ...overrides,
  };
}

describe('authorizeUserClaims — tenant and audience', () => {
  it('rejects when tid does not match the configured tenant', () => {
    const payload = basePayload({ tid: 'other-tenant-id' });
    expect(authorizeUserClaims(payload, baseOptions({ allowAnyTenantUser: true }))).toBeNull();
  });

  it('rejects when audience is not in the expected list', () => {
    const payload = basePayload({ aud: 'api://some-other-app' });
    expect(authorizeUserClaims(payload, baseOptions({ allowAnyTenantUser: true }))).toBeNull();
  });

  it('accepts when audience is an array containing an expected value', () => {
    const payload = basePayload({ aud: ['api://unrelated', `api://${CLIENT_ID}`] });
    const claims = authorizeUserClaims(payload, baseOptions({ allowAnyTenantUser: true }));
    expect(claims?.oid).toBe(OID_ALICE);
  });

  it('rejects when oid is missing', () => {
    const payload = basePayload({ oid: undefined });
    expect(authorizeUserClaims(payload, baseOptions({ allowAnyTenantUser: true }))).toBeNull();
  });
});

describe('authorizeUserClaims — SEC-F01 fail-closed authorization', () => {
  it('rejects every token when authorizedUserOids is empty and allowAnyTenantUser is false', () => {
    const payload = basePayload();
    expect(authorizeUserClaims(payload, baseOptions())).toBeNull();
  });

  it('accepts when authorizedUserOids is empty but allowAnyTenantUser is true', () => {
    const payload = basePayload();
    const claims = authorizeUserClaims(payload, baseOptions({ allowAnyTenantUser: true }));
    expect(claims).not.toBeNull();
    expect(claims?.oid).toBe(OID_ALICE);
  });

  it('accepts when oid is in the authorizedUserOids allowlist', () => {
    const payload = basePayload();
    const claims = authorizeUserClaims(
      payload,
      baseOptions({ authorizedUserOids: [OID_ALICE, OID_BOB] })
    );
    expect(claims?.oid).toBe(OID_ALICE);
  });

  it('rejects when oid is not in a non-empty authorizedUserOids allowlist, even with allowAnyTenantUser=true', () => {
    const payload = basePayload({ oid: 'cccccccc-cccc-cccc-cccc-cccccccccccc' });
    expect(
      authorizeUserClaims(
        payload,
        baseOptions({ authorizedUserOids: [OID_ALICE, OID_BOB], allowAnyTenantUser: true })
      )
    ).toBeNull();
  });
});

describe('authorizeUserClaims — SEC-F03 required scope enforcement', () => {
  it('accepts when all required scopes are present', () => {
    const payload = basePayload({ scp: 'profile access_as_user email' });
    const claims = authorizeUserClaims(
      payload,
      baseOptions({ allowAnyTenantUser: true, requiredScopes: ['access_as_user'] })
    );
    expect(claims?.oid).toBe(OID_ALICE);
  });

  it('rejects when a required scope is missing', () => {
    const payload = basePayload({ scp: 'profile email' });
    expect(
      authorizeUserClaims(
        payload,
        baseOptions({ allowAnyTenantUser: true, requiredScopes: ['access_as_user'] })
      )
    ).toBeNull();
  });

  it('rejects when the scp claim is missing entirely and scopes are required', () => {
    const payload = basePayload({ scp: undefined });
    expect(
      authorizeUserClaims(
        payload,
        baseOptions({ allowAnyTenantUser: true, requiredScopes: ['access_as_user'] })
      )
    ).toBeNull();
  });

  it('skips the scope check when requiredScopes is empty', () => {
    const payload = basePayload({ scp: undefined });
    const claims = authorizeUserClaims(
      payload,
      baseOptions({ allowAnyTenantUser: true, requiredScopes: [] })
    );
    expect(claims?.oid).toBe(OID_ALICE);
  });

  it('rejects when only one of multiple required scopes is present', () => {
    const payload = basePayload({ scp: 'access_as_user' });
    expect(
      authorizeUserClaims(
        payload,
        baseOptions({
          allowAnyTenantUser: true,
          requiredScopes: ['access_as_user', 'admin.full'],
        })
      )
    ).toBeNull();
  });
});

describe('authorizeUserClaims — claims extraction', () => {
  it('returns upn when present', () => {
    const payload = basePayload({ upn: 'alice@contoso.com', preferred_username: 'alice@other' });
    const claims = authorizeUserClaims(payload, baseOptions({ allowAnyTenantUser: true }));
    expect(claims?.upn).toBe('alice@contoso.com');
  });

  it('falls back to preferred_username when upn is missing', () => {
    const payload = basePayload({ upn: undefined, preferred_username: 'alice@contoso.com' });
    const claims = authorizeUserClaims(payload, baseOptions({ allowAnyTenantUser: true }));
    expect(claims?.upn).toBe('alice@contoso.com');
  });

  it('extracts appid from azp when appid is missing', () => {
    const payload = basePayload({ appid: undefined, azp: 'client-app-id' });
    const claims = authorizeUserClaims(payload, baseOptions({ allowAnyTenantUser: true }));
    expect(claims?.appid).toBe('client-app-id');
  });
});

describe('SEC-F08 (SEC-004) — formatUpnForLog', () => {
  it('returns the value verbatim when redact is false or undefined', () => {
    expect(formatUpnForLog('alice@contoso.com', false)).toBe('alice@contoso.com');
    expect(formatUpnForLog('alice@contoso.com', undefined)).toBe('alice@contoso.com');
  });

  it('returns a sha256-prefixed truncated hash when redact is true', () => {
    const out = formatUpnForLog('alice@contoso.com', true);
    expect(out).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(out).not.toContain('alice');
    expect(out).not.toContain('contoso');
  });

  it('is deterministic — the same UPN always hashes to the same prefix', () => {
    const a = formatUpnForLog('alice@contoso.com', true);
    const b = formatUpnForLog('alice@contoso.com', true);
    expect(a).toBe(b);
  });

  it('different UPNs produce different prefixes', () => {
    const alice = formatUpnForLog('alice@contoso.com', true);
    const bob = formatUpnForLog('bob@contoso.com', true);
    expect(alice).not.toBe(bob);
  });

  it('returns <none> for undefined or empty', () => {
    expect(formatUpnForLog(undefined, true)).toBe('<none>');
    expect(formatUpnForLog(undefined, false)).toBe('<none>');
    expect(formatUpnForLog('', true)).toBe('<none>');
  });
});

describe('authorizeUserClaimsExplain — RFC 6750 reason mapping', () => {
  // These tests guard the wire contract: identity / integrity failures must
  // surface as `invalid_token` (→ HTTP 401, client refreshes), and only a
  // missing required scope on an otherwise-valid token may surface as
  // `insufficient_scope` (→ HTTP 403, refresh would not help). Mis-mapping
  // expiry / audience to 403 caused infinite reconnect loops with mcp-remote
  // in the field.

  it('returns ok:true with claims when the token is fully valid', () => {
    const payload = basePayload();
    const result = authorizeUserClaimsExplain(
      payload,
      baseOptions({ allowAnyTenantUser: true, requiredScopes: ['access_as_user'] })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.oid).toBe(OID_ALICE);
    }
  });

  it('reports invalid_token on tenant mismatch', () => {
    const payload = basePayload({ tid: 'other-tenant-id' });
    const result = authorizeUserClaimsExplain(payload, baseOptions({ allowAnyTenantUser: true }));
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('reports invalid_token on audience mismatch', () => {
    const payload = basePayload({ aud: 'api://some-other-app' });
    const result = authorizeUserClaimsExplain(payload, baseOptions({ allowAnyTenantUser: true }));
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('reports invalid_token when oid is missing', () => {
    const payload = basePayload({ oid: undefined });
    const result = authorizeUserClaimsExplain(payload, baseOptions({ allowAnyTenantUser: true }));
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('reports invalid_token on SEC-F01 fail-closed (no allowlist, allowAnyTenantUser=false)', () => {
    const payload = basePayload();
    const result = authorizeUserClaimsExplain(payload, baseOptions());
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('reports invalid_token when oid is not in a non-empty allowlist', () => {
    const payload = basePayload({ oid: 'cccccccc-cccc-cccc-cccc-cccccccccccc' });
    const result = authorizeUserClaimsExplain(
      payload,
      baseOptions({ authorizedUserOids: [OID_ALICE, OID_BOB], allowAnyTenantUser: true })
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('reports insufficient_scope when scp is missing a required entry', () => {
    const payload = basePayload({ scp: 'profile email' });
    const result = authorizeUserClaimsExplain(
      payload,
      baseOptions({ allowAnyTenantUser: true, requiredScopes: ['access_as_user'] })
    );
    expect(result).toEqual({ ok: false, reason: 'insufficient_scope' });
  });

  it('reports insufficient_scope when scp claim is absent and scopes are required', () => {
    const payload = basePayload({ scp: undefined });
    const result = authorizeUserClaimsExplain(
      payload,
      baseOptions({ allowAnyTenantUser: true, requiredScopes: ['access_as_user'] })
    );
    expect(result).toEqual({ ok: false, reason: 'insufficient_scope' });
  });

  it('reports invalid_token (not insufficient_scope) when both identity and scope fail — identity wins', () => {
    // Audience mismatch is checked before the scope check, so the wire signal
    // should be invalid_token. This guards the order: a client that does not
    // even have the right audience must not be told "your scope is wrong"
    // (which would imply identity is fine).
    const payload = basePayload({ aud: 'api://some-other-app', scp: 'profile' });
    const result = authorizeUserClaimsExplain(
      payload,
      baseOptions({ allowAnyTenantUser: true, requiredScopes: ['access_as_user'] })
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });
});

describe('SEC-F08 (SEC-004) — UPN redaction in authorizeUserClaims rejection paths', () => {
  it('still rejects on missing allowlist regardless of redactUpn', () => {
    const payload = basePayload();
    expect(authorizeUserClaims(payload, baseOptions({ redactUpn: false }))).toBeNull();
    expect(authorizeUserClaims(payload, baseOptions({ redactUpn: true }))).toBeNull();
  });

  it('still rejects oid-not-in-allowlist regardless of redactUpn', () => {
    const payload = basePayload({ oid: OID_BOB });
    const opts = baseOptions({ authorizedUserOids: [OID_ALICE], redactUpn: true });
    expect(authorizeUserClaims(payload, opts)).toBeNull();
  });

  it('returned claims still carry plaintext upn (only logs are redacted)', () => {
    const payload = basePayload({ oid: OID_ALICE });
    const opts = baseOptions({
      authorizedUserOids: [OID_ALICE],
      redactUpn: true,
    });
    const claims = authorizeUserClaims(payload, opts);
    expect(claims?.upn).toBe('alice@contoso.com');
  });
});
