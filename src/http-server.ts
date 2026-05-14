import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import logger from './logger.js';
import { validateEntraTokenExplain, type TokenValidatorOptions } from './token-validator.js';
import {
  validateUserTokenExplain,
  type UserTokenValidatorOptions,
} from './user-token-validator.js';
import { formatUpnForLog } from './user-token-authorization.js';
import { registerOAuthRoutes, type OAuthProxyOptions } from './oauth-proxy.js';
import { registerOAuthRateLimiters } from './oauth-rate-limiters.js';
import rateLimit from 'express-rate-limit';

export interface HttpServerOptions {
  port: number;
  host?: string;
  createServer: (userToken?: string, roles?: string[]) => McpServer;
  tokenValidatorOptions?: TokenValidatorOptions;
  userTokenValidatorOptions?: UserTokenValidatorOptions;
  oauthProxyOptions?: OAuthProxyOptions;
}

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function resourceMetadataUrl(publicUrl: string): string {
  // SEC-F02: publicUrl is mandatory and validated by registerOAuthRoutes; no
  // header-derived fallback here either, to keep the WWW-Authenticate challenge
  // consistent with the advertised metadata.
  return `${stripTrailingSlash(publicUrl)}/.well-known/oauth-protected-resource`;
}

export interface McpAuthMiddlewareOptions {
  serviceValidator?: TokenValidatorOptions;
  userValidator?: UserTokenValidatorOptions;
  /**
   * When set, every challenge response includes a
   * `WWW-Authenticate: Bearer resource_metadata="..."` header pointing at the
   * RFC 9728 protected-resource metadata document. Omit when no OAuth proxy
   * is configured — there is nothing for the client to discover.
   */
  oauthPublicUrl?: string;
}

/**
 * Builds the `/mcp` Bearer-token validation middleware.
 *
 * Extracted from `startHttpServer` so it can be unit-tested in isolation
 * without spinning up the OAuth proxy, rate limiter, or MCP transport. The
 * RFC 6750 §3.1 status mapping (invalid_token → 401, insufficient_scope →
 * 403) is the load-bearing contract — see `http-server.test.ts` for the
 * regression suite that pins it.
 */
export function createMcpAuthMiddleware(
  options: McpAuthMiddlewareOptions
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const { serviceValidator, userValidator, oauthPublicUrl } = options;

  function setChallengeHeader(_req: Request, res: Response, errorCode?: string): void {
    if (!oauthPublicUrl) return;
    const metadata = resourceMetadataUrl(oauthPublicUrl);
    const parts = [`resource_metadata="${metadata}"`];
    if (errorCode) parts.push(`error="${errorCode}"`);
    res.setHeader('WWW-Authenticate', `Bearer ${parts.join(', ')}`);
  }

  return async function mcpAuthMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.info(`MCP ${req.method} ${req.path} → 401 (no bearer)`);
      setChallengeHeader(req, res);
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }
    const token = authHeader.slice(7);

    // RFC 6750 §3.1: distinguish `invalid_token` (→ 401, prompts the client
    // to refresh or re-authenticate) from `insufficient_scope` (→ 403, the
    // principal lacks permission and a refresh would not help). mcp-remote
    // and other compliant clients only attempt token refresh on 401; mapping
    // an expired access_token to 403 caused infinite reconnect loops in the
    // field — see commit history for the regression.
    let userInsufficientScope = false;
    if (userValidator) {
      const userResult = await validateUserTokenExplain(token, userValidator);
      if (userResult.ok) {
        // SEC-F08 (SEC-004): respect --log-redact-upn here too. The Entra `oid`
        // (non-PII GUID) stays plain when no UPN is present so operators can
        // still pivot through the directory.
        const upnForLog = formatUpnForLog(userResult.claims.upn, userValidator.redactUpn);
        logger.info(
          `MCP request authenticated as user ${userResult.claims.upn ? upnForLog : userResult.claims.oid} (oid ${userResult.claims.oid})`
        );
        // Store the raw bearer token so OBO can use it as the user assertion downstream.
        res.locals.userToken = token;
        // Propagate App Role assignments to the per-request McpServer so write
        // tools can be filtered by tier. Empty array = no Tools.Write.* role
        // granted = read-only session for this caller.
        res.locals.roles = userResult.claims.roles;
        next();
        return;
      }
      if (userResult.reason === 'insufficient_scope') {
        userInsufficientScope = true;
      }
    }

    if (serviceValidator) {
      const serviceResult = await validateEntraTokenExplain(token, serviceValidator);
      if (serviceResult.ok) {
        // Same role propagation for service-to-service callers. App Roles
        // assigned to the calling SP appear in the JWT `roles` claim.
        res.locals.roles = serviceResult.claims.roles;
        next();
        return;
      }
    }

    // If the user-token path rejected on insufficient_scope and the service
    // path could not rescue (or was not configured), the most accurate
    // signal back to the client is 403 insufficient_scope. Otherwise the
    // failure was identity/integrity (signature, expiry, audience, allowlist)
    // → 401 invalid_token, which lets the client refresh and retry.
    if (userInsufficientScope) {
      logger.warn(`MCP ${req.method} ${req.path} → 403 (insufficient_scope)`);
      setChallengeHeader(req, res, 'insufficient_scope');
      res.status(403).json({ error: 'insufficient_scope' });
      return;
    }

    logger.warn(`MCP ${req.method} ${req.path} → 401 (invalid_token)`);
    setChallengeHeader(req, res, 'invalid_token');
    res.status(401).json({ error: 'invalid_token' });
  };
}

export async function startHttpServer(options: HttpServerOptions): Promise<void> {
  const app = express();

  app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  app.use(
    '/mcp',
    rateLimit({
      windowMs: 60_000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests, please try again later' },
    })
  );

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', transport: 'http', timestamp: new Date().toISOString() });
  });

  if (options.oauthProxyOptions) {
    // SEC-F06: OAuth surface is public and must be rate-limited independently
    // of /mcp. Limiter setup lives in registerOAuthRateLimiters for
    // testability — see that function's docstring for the per-route policy.
    registerOAuthRateLimiters(app);
    registerOAuthRoutes(app, options.oauthProxyOptions);
    logger.info(
      'OAuth proxy routes enabled (/authorize, /token [split by grant_type], /devicecode, DCR, metadata) with rate limits'
    );
  }

  const serviceValidator = options.tokenValidatorOptions;
  const userValidator = options.userTokenValidatorOptions;

  if (!serviceValidator && !userValidator) {
    throw new Error(
      'HTTP transport requires at least one auth mode: --allowed-clients or --oauth-mode'
    );
  }

  app.use(
    '/mcp',
    createMcpAuthMiddleware({
      serviceValidator,
      userValidator,
      oauthPublicUrl: options.oauthProxyOptions?.publicUrl,
    })
  );

  async function handleMcpRequest(req: Request, res: Response): Promise<void> {
    const server = options.createServer(
      res.locals.userToken as string | undefined,
      res.locals.roles as string[] | undefined
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error(`MCP request error: ${(error as Error).message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  }

  app.post('/mcp', handleMcpRequest);
  app.delete('/mcp', handleMcpRequest);
  app.get('/mcp', handleMcpRequest);

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error(`Unhandled Express error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  const host = options.host || '127.0.0.1';
  app.listen(options.port, host, () => {
    logger.info(`HTTP MCP server listening on ${host}:${options.port}`);
  });
}
