import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import logger from './logger.js';
import type { OAuthStorage } from './storage/index.js';
import { hashClientSecret, verifyClientSecret } from './storage/index.js';
import { summarizeUpstreamError } from './upstream-error.js';

export interface OAuthProxyOptions {
  // SEC-F02: must be a non-empty absolute URL. The proxy advertises this as the
  // OAuth issuer and resource identifier in `/.well-known/...`. Deriving the
  // issuer from request headers (X-Forwarded-*, Host) is a metadata-poisoning
  // vector when the server is not behind a strict reverse proxy, so the
  // fallback was removed and callers must supply a trusted public URL.
  publicUrl: string;
  tenantId: string;
  // The protected-resource app: token audience + `api://{clientId}/access_as_user`.
  clientId: string;
  clientSecret?: string;
  // Optional dedicated OAuth *client* app (distinct from `clientId`). When set, the
  // proxy authenticates to Entra as this client for authorization_code / refresh_token
  // / device_code. This removes the client==resource self-reference, so refresh can
  // request `api://{clientId}/access_as_user` without AADSTS90009 and the token carries
  // `access_as_user`. When unset, the proxy uses `clientId`/`clientSecret` (self-resource
  // mode) and refresh falls back to `{clientId}/.default`. See AppSecrets.oauthClientId.
  oauthClientId?: string;
  oauthClientSecret?: string;
  scopes: string[];
  enableDynamicRegistration: boolean;
  // SEC-F04b + SEC-F05: externalised storage for PKCE bridge + DCR client
  // credentials. Replaces the previous in-memory Map so a stolen refresh token
  // cannot be redeemed without the per-client secret, and so the proxy can run
  // multi-replica without losing PKCE state between /authorize and /token.
  storage: OAuthStorage;
}

const PKCE_TTL_MS = 10 * 60 * 1000;
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function sha256Base64url(input: string): string {
  return base64url(crypto.createHash('sha256').update(input).digest());
}

function randomVerifier(): string {
  return base64url(crypto.randomBytes(64));
}

function randomClientSecret(): string {
  return base64url(crypto.randomBytes(32));
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

// RFC 6749 §2.3.1: `client_secret_basic` uses HTTP Basic auth in the
// Authorization header with form-urlencoded credentials. We also accept
// `client_secret_post` via the body (advertised as our only supported method).
function extractClientCredentials(req: Request): { clientId?: string; clientSecret?: string } {
  const body = req.body ?? {};
  const bodyId = typeof body.client_id === 'string' ? body.client_id : undefined;
  const bodySecret = typeof body.client_secret === 'string' ? body.client_secret : undefined;
  if (bodyId && bodySecret) return { clientId: bodyId, clientSecret: bodySecret };

  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep > 0) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, sep)),
          clientSecret: decodeURIComponent(decoded.slice(sep + 1)),
        };
      }
    } catch {
      /* fall through */
    }
  }
  return { clientId: bodyId, clientSecret: bodySecret };
}

export function registerOAuthRoutes(app: Express, options: OAuthProxyOptions): void {
  // SEC-F02: refuse to register the OAuth surface without a trusted public URL.
  // The metadata endpoints would otherwise advertise an attacker-controllable
  // issuer derived from request headers.
  if (!options.publicUrl || !/^https?:\/\//.test(options.publicUrl)) {
    throw new Error(
      'OAuth proxy requires --public-url to be a non-empty absolute URL (e.g. https://mcp.example.com). ' +
        'The metadata endpoints advertise this as the OAuth issuer and cannot fall back to request headers.'
    );
  }
  // SEC-F04b: DCR must be enabled so that /token can enforce per-client
  // credentials. An oauth-mode deployment without DCR has no way to bind
  // refresh-token redemption to a client authentication factor.
  if (!options.enableDynamicRegistration) {
    throw new Error(
      'OAuth proxy requires Dynamic Client Registration to be enabled (SEC-F04b): ' +
        '/token enforces per-client credentials issued at /register. ' +
        'Remove --no-dynamic-registration or disable --oauth-mode.'
    );
  }
  const storage = options.storage;
  const issuer = stripTrailingSlash(options.publicUrl);
  const authority = `https://login.microsoftonline.com/${options.tenantId}`;
  // Upstream Entra client identity. Defaults to the resource app (self-resource mode)
  // unless a dedicated OAuth client app is configured. `separateOAuthClient` gates the
  // refresh-token scope strategy below (per-scope vs {clientId}/.default).
  const upstreamClientId = options.oauthClientId ?? options.clientId;
  const upstreamClientSecret = options.oauthClientSecret ?? options.clientSecret;
  const separateOAuthClient = !!options.oauthClientId && options.oauthClientId !== options.clientId;
  const fallbackScope =
    options.scopes.length > 0
      ? options.scopes.join(' ')
      : `openid profile email offline_access api://${options.clientId}/access_as_user`;

  app.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      // RFC 8628 §3.1: advertised so device_code clients (headless containers,
      // CI runners, remote dev envs) can discover the endpoint without custom
      // config. Complementary to authorization_code + PKCE, not a replacement.
      device_authorization_endpoint: `${issuer}/devicecode`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token', DEVICE_CODE_GRANT],
      code_challenge_methods_supported: ['S256'],
      // SEC-F04b: confidential clients only. MCP clients obtain a secret at
      // /register and present it on every /token call.
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      scopes_supported: options.scopes.length > 0 ? options.scopes : fallbackScope.split(' '),
    });
  });

  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.json({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
    });
  });

  app.post('/register', async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const clientId = `mcp-client-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const clientSecret = randomClientSecret();
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];

    try {
      await storage.saveClient({
        clientId,
        clientSecretHash: hashClientSecret(clientSecret),
        redirectUris,
        createdAt: Date.now(),
      });
    } catch (error) {
      logger.error(`DCR saveClient failed: ${(error as Error).message}`);
      res.status(500).json({ error: 'server_error', error_description: 'Registration failed' });
      return;
    }

    logger.info(`DCR registered ${clientId}`);
    res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      // 0 means "does not expire" per RFC 7591 §3.2.1. Rotation is manual.
      client_secret_expires_at: 0,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: body.grant_types ?? ['authorization_code', 'refresh_token'],
      response_types: body.response_types ?? ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: body.scope ?? fallbackScope,
    });
  });

  // RFC 8628 §3.1: device authorization request. Clients that cannot launch a
  // browser (headless containers, remote SSH dev envs, CI runners) call this
  // endpoint, relay the user_code + verification_uri to the human operator,
  // and then poll /token with grant_type=urn:ietf:params:oauth:grant-type:device_code.
  // This path bypasses macOS Platform SSO / browser-extension interference
  // entirely: the authentication ceremony happens on any device the user
  // chooses (phone, laptop) rather than on the host running the MCP client.
  app.post('/devicecode', async (req: Request, res: Response) => {
    // SEC-F04b: device_authorization must require the same client
    // authentication as /token. A stolen device_code is bounded by Entra's
    // TTL, but an unauthenticated /devicecode would let anyone burn our
    // upstream rate budget and phish user_codes.
    const { clientId: reqClientId, clientSecret: reqClientSecret } = extractClientCredentials(req);
    if (!reqClientId || !reqClientSecret) {
      res.status(401).json({
        error: 'invalid_client',
        error_description: 'Missing client_id or client_secret',
      });
      return;
    }
    const registered = await storage.getClient(reqClientId);
    if (!registered || !verifyClientSecret(reqClientSecret, registered.clientSecretHash)) {
      logger.warn(`OAuth /devicecode rejected: invalid client credentials for ${reqClientId}`);
      res
        .status(401)
        .json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
      return;
    }

    const body = req.body ?? {};
    const requestedScope =
      typeof body.scope === 'string' && body.scope.length > 0 ? body.scope : fallbackScope;
    const scopeList = requestedScope.split(/\s+/).filter(Boolean);
    if (!scopeList.includes('offline_access')) {
      scopeList.push('offline_access');
    }
    const upstreamScope = scopeList.join(' ');

    const form = new URLSearchParams();
    form.set('client_id', upstreamClientId);
    form.set('scope', upstreamScope);

    try {
      const upstream = await fetch(`${authority}/oauth2/v2.0/devicecode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      const payload = await upstream.text();
      if (upstream.status >= 400) {
        logger.warn(
          `Entra /devicecode returned ${upstream.status} for client=${reqClientId}: ${summarizeUpstreamError(payload)}`
        );
      } else {
        logger.info(`OAuth /devicecode issued (client=${reqClientId}, scope=${upstreamScope})`);
      }
      res.status(upstream.status).type('application/json').send(payload);
    } catch (error) {
      logger.error(`Entra devicecode request failed: ${(error as Error).message}`);
      res
        .status(502)
        .json({ error: 'server_error', error_description: 'Upstream devicecode request failed' });
    }
  });

  app.get('/authorize', async (req: Request, res: Response) => {
    const {
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: clientChallenge,
      code_challenge_method: clientChallengeMethod,
      scope,
    } = req.query as Record<string, string | undefined>;

    if (!clientId || !redirectUri || !clientChallenge) {
      logger.warn('OAuth /authorize rejected: missing client_id, redirect_uri or code_challenge');
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Missing client_id, redirect_uri or code_challenge',
      });
      return;
    }
    if (clientChallengeMethod && clientChallengeMethod !== 'S256') {
      logger.warn(
        `OAuth /authorize rejected: unsupported challenge method ${clientChallengeMethod}`
      );
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Only S256 code_challenge_method is supported',
      });
      return;
    }

    // SEC-F04b: /authorize must only accept DCR-issued client_ids. An unknown
    // client_id would let a caller who doesn't possess the secret still funnel
    // an auth code through the proxy.
    const known = await storage.getClient(clientId);
    if (!known) {
      logger.warn(`OAuth /authorize rejected: unknown client_id ${clientId}`);
      res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
      return;
    }

    // SEC-F04c (SEC-002): /authorize must verify that the redirect_uri matches
    // one of the URIs registered at /register (DCR). Without this, anyone who
    // possesses a client_id + secret pair (e.g. recovered from a shared
    // ~/.mcp-auth cache) can swap in an attacker-controlled redirect_uri and
    // exfiltrate the auth code — Entra's upstream allowlist mitigates only when
    // the operator has tightly configured their app registration. We enforce at
    // this proxy regardless. Empty redirectUris means the client registered
    // none (legacy / minimal DCR call) — we don't enforce in that case to keep
    // backward compatibility with existing deployments, but log it.
    if (known.redirectUris.length === 0) {
      logger.warn(
        `OAuth /authorize: client ${clientId} has no registered redirect_uris — skipping enforcement`
      );
    } else if (!known.redirectUris.includes(redirectUri)) {
      logger.warn(
        `OAuth /authorize rejected: redirect_uri ${redirectUri} not in registered list for ${clientId}`
      );
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'redirect_uri does not match a registered URI',
      });
      return;
    }

    const serverVerifier = randomVerifier();
    const serverChallenge = sha256Base64url(serverVerifier);
    await storage.savePkce({
      clientChallenge,
      serverVerifier,
      redirectUri,
      clientId,
      // SEC-F04d (SEC-007): record the client's state for audit correlation.
      // The proxy never observes the redirect callback (Entra → client direct),
      // so cannot validate round-trip equivalence — but storing state lets us
      // correlate /authorize and /token entries for the same OAuth session in
      // the audit logs, which is otherwise impossible across the PKCE bridge.
      // Optional: clients may omit state per RFC 6749 §10.12.
      clientState: state,
      expiresAt: Date.now() + PKCE_TTL_MS,
    });

    // Entra only issues a refresh token when offline_access is in the requested
    // scope. MCP clients (Claude Desktop, claude.ai, etc.) often send their own
    // scope list that omits it — without this merge, access tokens expire after
    // 60-90 min and users re-authenticate on every call. See Softeria PR #407.
    const requestedScope = scope || fallbackScope;
    const scopeList = requestedScope.split(/\s+/).filter(Boolean);
    if (!scopeList.includes('offline_access')) {
      scopeList.push('offline_access');
    }
    const upstreamScope = scopeList.join(' ');

    const upstream = new URL(`${authority}/oauth2/v2.0/authorize`);
    upstream.searchParams.set('client_id', upstreamClientId);
    upstream.searchParams.set('response_type', 'code');
    upstream.searchParams.set('redirect_uri', redirectUri);
    upstream.searchParams.set('response_mode', 'query');
    upstream.searchParams.set('scope', upstreamScope);
    upstream.searchParams.set('code_challenge', serverChallenge);
    upstream.searchParams.set('code_challenge_method', 'S256');
    if (state) upstream.searchParams.set('state', state);
    // Force Entra's account picker on every sign-in to prevent silent SSO
    // reuse of a wrong account. Critical for multi-account admin workflows
    // where a user has both a standard and an admin identity in the tenant.
    // Note: ineffective against macOS Platform SSO extension in Safari/WebKit
    // (the extension injects a PRT before Entra sees the prompt param) —
    // use a non-WebKit browser (Chrome, Firefox) to bypass that layer.
    upstream.searchParams.set('prompt', 'select_account');

    // SEC-F04d (SEC-007): include state in the audit log so /authorize and
    // /token entries can be correlated to the same OAuth session.
    logger.info(
      `OAuth /authorize → Entra (client=${clientId}, redirect_uri=${redirectUri}, scope=${upstreamScope}, prompt=select_account, state=${state ?? '(none)'})`
    );
    res.redirect(302, upstream.toString());
  });

  app.post('/token', async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const grantType = body.grant_type;

    // SEC-F04b: require client authentication on every /token call. A stolen
    // authorization_code or refresh_token is useless without the client_secret
    // issued at /register.
    const { clientId: reqClientId, clientSecret: reqClientSecret } = extractClientCredentials(req);
    if (!reqClientId || !reqClientSecret) {
      res.status(401).json({
        error: 'invalid_client',
        error_description: 'Missing client_id or client_secret',
      });
      return;
    }
    const registered = await storage.getClient(reqClientId);
    if (!registered || !verifyClientSecret(reqClientSecret, registered.clientSecretHash)) {
      logger.warn(`OAuth /token rejected: invalid client credentials for ${reqClientId}`);
      res
        .status(401)
        .json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
      return;
    }

    const form = new URLSearchParams();
    form.set('client_id', upstreamClientId);
    if (upstreamClientSecret) form.set('client_secret', upstreamClientSecret);

    if (grantType === 'authorization_code') {
      const code = body.code as string | undefined;
      const clientVerifier = body.code_verifier as string | undefined;
      const redirectUri = body.redirect_uri as string | undefined;

      if (!code || !clientVerifier || !redirectUri) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'Missing code, code_verifier, or redirect_uri',
        });
        return;
      }

      const clientChallenge = sha256Base64url(clientVerifier);
      const bridge = await storage.consumePkce(clientChallenge);
      if (!bridge) {
        res.status(400).json({
          error: 'invalid_grant',
          error_description: 'PKCE bridge entry missing or expired',
        });
        return;
      }
      // SEC-F04b: a client cannot redeem a code obtained under a different
      // client_id. This prevents a compromised client from redeeming another
      // client's auth code even if it races the PKCE consumption.
      if (bridge.clientId !== reqClientId) {
        logger.warn(
          `OAuth /token rejected: client_id mismatch (bridge=${bridge.clientId}, req=${reqClientId})`
        );
        res.status(400).json({
          error: 'invalid_grant',
          error_description: 'client_id does not match the one used at /authorize',
        });
        return;
      }
      // SEC-F04c (SEC-002): the redirect_uri presented at /token must match
      // the one bound to the auth code at /authorize. RFC 6749 §4.1.3 requires
      // this check. Without it, an attacker who steals an auth code could
      // redeem it pointing at their own redirect target.
      if (bridge.redirectUri !== redirectUri) {
        logger.warn(
          `OAuth /token rejected: redirect_uri mismatch (bridge=${bridge.redirectUri}, req=${redirectUri})`
        );
        res.status(400).json({
          error: 'invalid_grant',
          error_description: 'redirect_uri does not match the one used at /authorize',
        });
        return;
      }

      // SEC-F04d (SEC-007): log the state recorded at /authorize so audit can
      // correlate this /token call to the originating session. The proxy never
      // sees the redirect callback, so this log line is the only record that
      // ties the two endpoints together for a single OAuth flow.
      logger.info(
        `OAuth /token authorization_code redemption (client=${reqClientId}, state=${bridge.clientState ?? '(none)'})`
      );

      form.set('grant_type', 'authorization_code');
      form.set('code', code);
      form.set('redirect_uri', bridge.redirectUri);
      form.set('code_verifier', bridge.serverVerifier);
    } else if (grantType === 'refresh_token') {
      const refreshToken = body.refresh_token as string | undefined;
      if (!refreshToken) {
        res
          .status(400)
          .json({ error: 'invalid_request', error_description: 'Missing refresh_token' });
        return;
      }
      form.set('grant_type', 'refresh_token');
      form.set('refresh_token', refreshToken);
      // Refresh-token scope strategy depends on whether a dedicated OAuth client app
      // is configured (see upstreamClientId / separateOAuthClient above).
      //
      // - Separate client app (preferred): client != resource, so we request the
      //   resource per-scope `api://{clientId}/access_as_user`. No self-reference, so
      //   no AADSTS90009, and the issued token carries `access_as_user` — letting
      //   SEC-F03 stay enabled.
      //
      // - Self-resource fallback (no oauthClientId): the app is BOTH client and
      //   resource. Entra rejects `refresh_token` for that self-reference unless the
      //   resource is named by its GUID-based app identifier with /.default:
      //   "Application is requesting a token for itself ... supported only if resource
      //   is specified using the GUID based App Identifier." Forwarding the per-scope
      //   value or omitting scope both fail (confirmed in prod). `{clientId}/.default`
      //   works but the token then carries Graph delegated scopes (not access_as_user),
      //   so SEC-F03 must be disabled in that mode. offline_access keeps the RT rotating.
      if (separateOAuthClient) {
        form.set('scope', `api://${options.clientId}/access_as_user offline_access`);
      } else {
        form.set('scope', `${options.clientId}/.default offline_access`);
      }
    } else if (grantType === DEVICE_CODE_GRANT) {
      // RFC 8628 §3.4: token redemption for a device_code. Entra returns
      // authorization_pending / slow_down / expired_token / access_denied
      // as standard OAuth errors with 4xx status — we relay them verbatim so
      // the client-side poller can honour them.
      const deviceCode = body.device_code as string | undefined;
      if (!deviceCode) {
        res
          .status(400)
          .json({ error: 'invalid_request', error_description: 'Missing device_code' });
        return;
      }
      form.set('grant_type', DEVICE_CODE_GRANT);
      form.set('device_code', deviceCode);
    } else {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }

    try {
      const upstream = await fetch(`${authority}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      const payload = await upstream.text();
      if (upstream.status >= 400) {
        // SEC-F07: scrub upstream error — log only parsed OAuth-standard fields.
        logger.warn(
          `Entra /token returned ${upstream.status} for grant_type=${grantType}: ${summarizeUpstreamError(payload)}`
        );
      } else {
        logger.info(`Entra /token exchange ok (grant_type=${grantType}, client=${reqClientId})`);
      }
      res.status(upstream.status).type('application/json').send(payload);
    } catch (error) {
      logger.error(`Entra token exchange failed: ${(error as Error).message}`);
      res
        .status(502)
        .json({ error: 'server_error', error_description: 'Upstream token exchange failed' });
    }
  });
}
