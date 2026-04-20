import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import logger from './logger.js';

export interface OAuthProxyOptions {
  publicUrl: string;
  tenantId: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  enableDynamicRegistration: boolean;
}

interface PkceEntry {
  serverVerifier: string;
  redirectUri: string;
  expiresAt: number;
}

const PKCE_TTL_MS = 10 * 60 * 1000;
const PKCE_MAX_ENTRIES = 1000;
const pkceBridge = new Map<string, PkceEntry>();

function pruneExpired(): void {
  const now = Date.now();
  if (pkceBridge.size <= PKCE_MAX_ENTRIES) {
    for (const [k, v] of pkceBridge) {
      if (v.expiresAt < now) pkceBridge.delete(k);
    }
    return;
  }
  const entries = [...pkceBridge.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  for (let i = 0; i < entries.length - PKCE_MAX_ENTRIES; i++) {
    pkceBridge.delete(entries[i][0]);
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function sha256Base64url(input: string): string {
  return base64url(crypto.createHash('sha256').update(input).digest());
}

function randomVerifier(): string {
  return base64url(crypto.randomBytes(64));
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function resolveIssuer(req: Request, configured: string): string {
  if (configured) return stripTrailingSlash(configured);
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
  return `${proto}://${host}`;
}

export function registerOAuthRoutes(app: Express, options: OAuthProxyOptions): void {
  const authority = `https://login.microsoftonline.com/${options.tenantId}`;
  const fallbackScope =
    options.scopes.length > 0
      ? options.scopes.join(' ')
      : `openid profile email offline_access api://${options.clientId}/access_as_user`;

  app.get('/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
    const issuer = resolveIssuer(req, options.publicUrl);
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: options.enableDynamicRegistration ? `${issuer}/register` : undefined,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: options.scopes.length > 0 ? options.scopes : fallbackScope.split(' '),
    });
  });

  app.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
    const issuer = resolveIssuer(req, options.publicUrl);
    res.json({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
    });
  });

  if (options.enableDynamicRegistration) {
    app.post('/register', (req: Request, res: Response) => {
      const body = req.body ?? {};
      const clientId = `mcp-client-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      res.status(201).json({
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: body.redirect_uris ?? [],
        grant_types: body.grant_types ?? ['authorization_code', 'refresh_token'],
        response_types: body.response_types ?? ['code'],
        token_endpoint_auth_method: 'none',
        scope: body.scope ?? fallbackScope,
      });
    });
  }

  app.get('/authorize', (req: Request, res: Response) => {
    const {
      redirect_uri: redirectUri,
      state,
      code_challenge: clientChallenge,
      code_challenge_method: clientChallengeMethod,
      scope,
    } = req.query as Record<string, string | undefined>;

    if (!redirectUri || !clientChallenge) {
      logger.warn('OAuth /authorize rejected: missing redirect_uri or code_challenge');
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Missing redirect_uri or code_challenge',
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

    pruneExpired();
    const serverVerifier = randomVerifier();
    const serverChallenge = sha256Base64url(serverVerifier);
    pkceBridge.set(clientChallenge, {
      serverVerifier,
      redirectUri,
      expiresAt: Date.now() + PKCE_TTL_MS,
    });

    const upstream = new URL(`${authority}/oauth2/v2.0/authorize`);
    upstream.searchParams.set('client_id', options.clientId);
    upstream.searchParams.set('response_type', 'code');
    upstream.searchParams.set('redirect_uri', redirectUri);
    upstream.searchParams.set('response_mode', 'query');
    upstream.searchParams.set('scope', scope || fallbackScope);
    upstream.searchParams.set('code_challenge', serverChallenge);
    upstream.searchParams.set('code_challenge_method', 'S256');
    if (state) upstream.searchParams.set('state', state);

    logger.info(
      `OAuth /authorize → Entra (redirect_uri=${redirectUri}, scope=${scope || fallbackScope})`
    );
    res.redirect(302, upstream.toString());
  });

  app.post('/token', async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const grantType = body.grant_type;

    const form = new URLSearchParams();
    form.set('client_id', options.clientId);
    if (options.clientSecret) form.set('client_secret', options.clientSecret);

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
      const bridge = pkceBridge.get(clientChallenge);
      if (!bridge || bridge.expiresAt < Date.now()) {
        res.status(400).json({
          error: 'invalid_grant',
          error_description: 'PKCE bridge entry missing or expired',
        });
        return;
      }
      pkceBridge.delete(clientChallenge);

      form.set('grant_type', 'authorization_code');
      form.set('code', code);
      form.set('redirect_uri', redirectUri);
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
      if (body.scope) form.set('scope', body.scope as string);
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
        logger.warn(
          `Entra /token returned ${upstream.status} for grant_type=${grantType}: ${payload.slice(0, 500)}`
        );
      } else {
        logger.info(`Entra /token exchange ok (grant_type=${grantType})`);
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
