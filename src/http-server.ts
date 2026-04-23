import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import rateLimit from 'express-rate-limit';
import logger from './logger.js';
import { validateEntraToken, type TokenValidatorOptions } from './token-validator.js';
import { validateUserToken, type UserTokenValidatorOptions } from './user-token-validator.js';
import { registerOAuthRoutes, type OAuthProxyOptions } from './oauth-proxy.js';

export interface HttpServerOptions {
  port: number;
  host?: string;
  createServer: (userToken?: string) => McpServer;
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
    // of /mcp. /token is the tightest (brute-forcing auth codes / refresh tokens
    // lives here); /authorize is looser because it's a user-initiated redirect.
    app.use(
      '/authorize',
      rateLimit({
        windowMs: 60_000,
        max: 30,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'invalid_request', error_description: 'Too many authorize requests' },
      })
    );
    const tokenLimiter = rateLimit({
      windowMs: 60_000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'invalid_request', error_description: 'Too many token requests' },
    });
    app.use('/token', tokenLimiter);
    app.use('/register', tokenLimiter);
    // /devicecode issues upstream device_codes on behalf of a DCR client;
    // same blast radius as /token, so it shares the tight limiter.
    app.use('/devicecode', tokenLimiter);
    registerOAuthRoutes(app, options.oauthProxyOptions);
    logger.info(
      'OAuth proxy routes enabled (/authorize, /token, /devicecode, DCR, metadata) with rate limits'
    );
  }

  const serviceValidator = options.tokenValidatorOptions;
  const userValidator = options.userTokenValidatorOptions;

  if (!serviceValidator && !userValidator) {
    throw new Error(
      'HTTP transport requires at least one auth mode: --allowed-clients or --oauth-mode'
    );
  }

  const oauthPublicUrl = options.oauthProxyOptions?.publicUrl;
  const oauthEnabled = Boolean(options.oauthProxyOptions);

  function setChallengeHeader(_req: Request, res: Response, errorCode?: string): void {
    if (!oauthEnabled || !oauthPublicUrl) return;
    const metadata = resourceMetadataUrl(oauthPublicUrl);
    const parts = [`resource_metadata="${metadata}"`];
    if (errorCode) parts.push(`error="${errorCode}"`);
    res.setHeader('WWW-Authenticate', `Bearer ${parts.join(', ')}`);
  }

  app.use('/mcp', async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.info(`MCP ${req.method} ${req.path} → 401 (no bearer)`);
      setChallengeHeader(req, res);
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }
    const token = authHeader.slice(7);

    if (userValidator) {
      const userClaims = await validateUserToken(token, userValidator);
      if (userClaims) {
        logger.info(`MCP request authenticated as user ${userClaims.upn ?? userClaims.oid}`);
        // Store the raw bearer token so OBO can use it as the user assertion downstream.
        res.locals.userToken = token;
        next();
        return;
      }
    }

    if (serviceValidator) {
      const serviceValid = await validateEntraToken(token, serviceValidator);
      if (serviceValid) {
        next();
        return;
      }
    }

    logger.warn(`MCP ${req.method} ${req.path} → 403 (token validation failed)`);
    setChallengeHeader(req, res, 'invalid_token');
    res.status(403).json({ error: 'Token validation failed' });
  });

  async function handleMcpRequest(req: Request, res: Response): Promise<void> {
    const server = options.createServer(res.locals.userToken as string | undefined);
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
