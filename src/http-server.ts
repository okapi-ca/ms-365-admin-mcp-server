import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import rateLimit from 'express-rate-limit';
import logger from './logger.js';
import { validateEntraToken, type TokenValidatorOptions } from './token-validator.js';

export interface HttpServerOptions {
  port: number;
  host?: string;
  server: McpServer;
  tokenValidatorOptions: TokenValidatorOptions;
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

  // SEC-07: Security headers on all responses
  app.use(securityHeaders);

  // SEC-05: Explicit body size limit
  app.use(express.json({ limit: '100kb' }));

  // SEC-04: Rate limiting
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

  // SEC-03: Auth middleware is always applied (--allowed-clients is mandatory)
  const validatorOptions = options.tokenValidatorOptions;
  app.use('/mcp', async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }
    const token = authHeader.slice(7);
    const valid = await validateEntraToken(token, validatorOptions);
    if (!valid) {
      res.status(403).json({ error: 'Token validation failed' });
      return;
    }
    next();
  });

  // SEC-12: Wrap handlers in try-catch
  async function handleMcpRequest(req: Request, res: Response): Promise<void> {
    try {
      // SEC-E: Stateless — each request creates a fresh transport. Session affinity is
      // handled by the Entra token validation (tenant + allowed-clients).
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

  // SEC-12: Global error handler — suppress stack traces
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error(`Unhandled Express error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // SEC-06: Bind to specific host (127.0.0.1 by default)
  const host = options.host || '127.0.0.1';
  app.listen(options.port, host, () => {
    logger.info(`HTTP MCP server listening on ${host}:${options.port}`);
  });
}
