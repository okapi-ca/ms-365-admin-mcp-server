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
  private server: McpServer | null;
  private secrets: AppSecrets | null;
  private version: string = '0.1.0';

  constructor(authManager: AuthManager, options: CommandOptions = {}) {
    this.authManager = authManager;
    this.options = options;
    this.server = null;
    this.secrets = null;
  }

  async initialize(version: string): Promise<void> {
    this.secrets = await getSecrets();
    this.version = version;
    // stdio transport uses app-only (no user token available)
    this.server = this.createServer();
  }

  createServer(userToken?: string): McpServer {
    const server = new McpServer({
      name: 'Microsoft365AdminMCP',
      version: this.version,
    });
    // OBO: when a user token is present (HTTP + --oauth-mode), exchange it for a
    // Graph token scoped to the caller's Entra permissions. App-only is used for
    // stdio transport and service-to-service tokens (--allowed-clients).
    const getToken = userToken
      ? () => this.authManager.getTokenOnBehalfOf(userToken)
      : () => this.authManager.getToken();
    const graphClient = new GraphClient(getToken, this.secrets!);
    // In OBO mode some tools require permissions that have no delegated equivalent
    // (e.g. Exchange.ManageAsApp, BitlockerKey.Read.All). Those tools fall back to
    // the app-only client so they continue to function while all other tools use OBO.
    const appOnlyGraphClient = userToken
      ? new GraphClient(() => this.authManager.getToken(), this.secrets!)
      : undefined;
    registerGraphTools(
      server,
      graphClient,
      this.options.readOnly,
      this.options.enabledTools,
      this.options.maxRiskLevel,
      appOnlyGraphClient
    );
    return server;
  }

  async start(): Promise<void> {
    if (this.options.v || this.options.transport === 'http') {
      enableConsoleLogging();
    }

    logger.info('Microsoft 365 Admin MCP Server starting...');
    if (this.options.oauthMode) {
      logger.info(
        'Auth mode: OBO delegated (user tokens forwarded to Graph via on-behalf-of flow)'
      );
    } else {
      logger.info('Auth mode: client credentials (application permissions)');
    }

    if (this.options.readOnly) {
      logger.info('Server running in READ-ONLY mode.');
    }

    if (this.options.transport === 'http') {
      if (!this.options.allowedClients && !this.options.oauthMode) {
        throw new Error(
          'HTTP transport requires at least one auth mode: --allowed-clients (service-to-service) or --oauth-mode (human users).'
        );
      }

      const { startHttpServer } = await import('./http-server.js');
      const port = parseInt(this.options.port || '8080', 10);
      if (port < 1 || port > 65535 || !Number.isFinite(port)) {
        throw new Error(`Invalid port: ${this.options.port}. Must be between 1 and 65535.`);
      }

      const tokenValidatorOptions = this.options.allowedClients
        ? {
            tenantId: this.secrets!.tenantId,
            allowedClientIds: this.options.allowedClients.split(',').map((id: string) => id.trim()),
            expectedAudience: `api://${this.secrets!.clientId}`,
          }
        : undefined;

      const authorizedUserOids = (this.options.authorizedUsers || '')
        .split(',')
        .map((o: string) => o.trim())
        .filter(Boolean);

      const allowAnyTenantUser = Boolean(this.options.allowAnyTenantUser);

      // SEC-F01: refuse to start if OAuth mode is enabled without any authorization surface.
      if (this.options.oauthMode && authorizedUserOids.length === 0 && !allowAnyTenantUser) {
        throw new Error(
          'OAuth mode requires either --authorized-users <oids> (per-user allowlist) ' +
            'or --allow-any-tenant-user (accept any tenant user). ' +
            'Starting without one of these would leave the /mcp endpoint open to every authenticated tenant user.'
        );
      }

      // SEC-F02: refuse to start if OAuth mode is enabled without a trusted public URL.
      // The metadata endpoints advertise this as the OAuth issuer; falling back to
      // request headers would let a client forge the advertised issuer via Host.
      if (this.options.oauthMode) {
        const url = this.options.publicUrl;
        if (!url || !/^https?:\/\//.test(url)) {
          throw new Error(
            'OAuth mode requires --public-url to be a non-empty absolute URL (e.g. https://mcp.example.com). ' +
              'The OAuth metadata endpoints advertise this URL as the issuer.'
          );
        }
      }

      // SEC-F03: default to requiring `access_as_user` in scp. An empty string disables the check.
      const requiredScopes =
        this.options.requiredUserScopes === undefined
          ? ['access_as_user']
          : this.options.requiredUserScopes
              .split(',')
              .map((s: string) => s.trim())
              .filter(Boolean);

      const userTokenValidatorOptions = this.options.oauthMode
        ? {
            tenantId: this.secrets!.tenantId,
            expectedAudiences: [
              this.secrets!.clientId,
              `api://${this.secrets!.clientId}`,
              '00000003-0000-0000-c000-000000000000',
            ],
            authorizedUserOids,
            allowAnyTenantUser,
            requiredScopes,
          }
        : undefined;

      let oauthProxyOptions: import('./oauth-proxy.js').OAuthProxyOptions | undefined;
      if (this.options.oauthMode) {
        const { createOAuthStorage } = await import('./storage/index.js');
        const storage = await createOAuthStorage();
        oauthProxyOptions = {
          publicUrl: this.options.publicUrl || '',
          tenantId: this.secrets!.tenantId,
          clientId: this.secrets!.clientId,
          clientSecret: this.secrets!.clientSecret,
          scopes: [
            'openid',
            'profile',
            'email',
            'offline_access',
            `api://${this.secrets!.clientId}/access_as_user`,
          ],
          enableDynamicRegistration: this.options.dynamicRegistration !== false,
          storage,
        };
      }

      await startHttpServer({
        port,
        host: this.options.host || '127.0.0.1',
        createServer: (userToken?: string) => this.createServer(userToken),
        tokenValidatorOptions,
        userTokenValidatorOptions,
        oauthProxyOptions,
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
