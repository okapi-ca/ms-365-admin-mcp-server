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
  server: McpServer;
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

export async function startHttpServer(options: HttpServerOptions): Promise<void> {
  const app = express();

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
    registerOAuthRoutes(app, options.oauthProxyOptions);
    logger.info('OAuth proxy routes enabled (/authorize, /token, DCR, metadata)');
  }

  const serviceValidator = options.tokenValidatorOptions;
  const userValidator = options.userTokenValidatorOptions;

  if (!serviceValidator && !userValidator) {
    throw new Error(
      'HTTP transport requires at least one auth mode: --allowed-clients or --oauth-mode'
    );
  }

  app.use('/mcp', async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }
    const token = authHeader.slice(7);

    if (userValidator) {
      const userClaims = await validateUserToken(token, userValidator);
      if (userClaims) {
        logger.info(`MCP request authenticated as user ${userClaims.upn ?? userClaims.oid}`);
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

    res.status(403).json({ error: 'Token validation failed' });
  });

  async function handleMcpRequest(req: Request, res: Response): Promise<void> {
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await options.server.connect(transport);
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
