import { describe, it, expect } from 'vitest';
import {
  authorizeUserClaims,
  type UserTokenValidatorOptions,
} from '../src/user-token-validator.js';

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
