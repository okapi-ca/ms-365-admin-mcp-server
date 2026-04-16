import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import logger, { enableConsoleLogging } from './logger.js';
import { registerGraphTools } from './graph-tools.js';
import GraphClient from './graph-client.js';
import AuthManager from './auth.js';
import type { CommandOptions } from './cli.ts';
import { getSecrets, type AppSecrets } from './secrets.js';

class AdminGraphServer {
  private authManager: AuthManager;
  private options: CommandOptions;
  private graphClient: GraphClient | null;
  private server: McpServer | null;
  private secrets: AppSecrets | null;
  private version: string = '0.1.0';

  constructor(authManager: AuthManager, options: CommandOptions = {}) {
    this.authManager = authManager;
    this.options = options;
    this.graphClient = null;
    this.server = null;
    this.secrets = null;
  }

  async initialize(version: string): Promise<void> {
    this.secrets = await getSecrets();
    this.version = version;
    this.graphClient = new GraphClient(this.authManager, this.secrets);

    this.server = new McpServer({
      name: 'Microsoft365AdminMCP',
      version: this.version,
    });

    registerGraphTools(
      this.server,
      this.graphClient,
      this.options.readOnly,
      this.options.enabledTools
    );
  }

  async start(): Promise<void> {
    if (this.options.v) {
      enableConsoleLogging();
    }

    logger.info('Microsoft 365 Admin MCP Server starting...');
    logger.info('Auth mode: client credentials (application permissions)');

    if (this.options.readOnly) {
      logger.info('Server running in READ-ONLY mode.');
    }

    if (this.options.transport === 'http') {
      if (!this.options.allowedClients) {
        throw new Error(
          '--allowed-clients is required when using --transport http. ' +
            'Provide comma-separated Entra app IDs to secure the HTTP endpoint.'
        );
      }

      const { startHttpServer } = await import('./http-server.js');
      const port = parseInt(this.options.port || '8080', 10);
      if (port < 1 || port > 65535 || !Number.isFinite(port)) {
        throw new Error(`Invalid port: ${this.options.port}. Must be between 1 and 65535.`);
      }

      const tokenValidatorOptions = {
        tenantId: this.secrets!.tenantId,
        allowedClientIds: this.options.allowedClients.split(',').map((id: string) => id.trim()),
      };

      await startHttpServer({
        port,
        host: this.options.host || '127.0.0.1',
        server: this.server!,
        tokenValidatorOptions,
      });
      logger.info(`Server connected to HTTP transport on port ${port}`);
    } else {
      const transport = new StdioServerTransport();
      await this.server!.connect(transport);
      logger.info('Server connected to stdio transport');
    }
  }
}

export default AdminGraphServer;
