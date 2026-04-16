import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import logger from './logger.js';
import { validateEntraToken, type TokenValidatorOptions } from './token-validator.js';

export interface HttpServerOptions {
  port: number;
  server: McpServer;
  tokenValidatorOptions?: TokenValidatorOptions;
}

export async function startHttpServer(options: HttpServerOptions): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', transport: 'http', timestamp: new Date().toISOString() });
  });

  if (options.tokenValidatorOptions) {
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
  }

  // Stateless MCP endpoint — each request gets its own transport
  app.post('/mcp', async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await options.server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await options.server.connect(transport);
    await transport.handleRequest(req, res);
  });

  app.get('/mcp', async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await options.server.connect(transport);
    await transport.handleRequest(req, res);
  });

  app.listen(options.port, () => {
    logger.info(`HTTP MCP server listening on port ${options.port}`);
  });
}
