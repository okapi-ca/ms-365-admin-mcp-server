import logger from './logger.js';
import { parseCloudType, type CloudType } from './cloud-config.js';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Required environment variable ${name} is not set. ` +
        `Register an app in Azure AD and configure all MS365_ADMIN_MCP_* variables.`
    );
  }
  return value;
}

export interface AppSecrets {
  clientId: string;
  tenantId: string;
  clientSecret?: string;
  cloudType: CloudType;
  // Optional dedicated OAuth *client* app, distinct from the resource app above
  // (`clientId` is the protected resource: token audience + `api://{clientId}/access_as_user`).
  // When set, the OAuth proxy authenticates to Entra as this client for the
  // authorization_code / refresh_token / device_code flows. Because the client is
  // then no longer the same app as the resource, a refresh can request
  // `api://{resourceClientId}/access_as_user` without the self-reference that
  // triggers AADSTS90009 — and the issued token carries `access_as_user`, letting
  // SEC-F03 stay enabled. Leave unset to keep the single self-resource app
  // (refresh falls back to `{clientId}/.default`; SEC-F03 must be disabled).
  oauthClientId?: string;
  oauthClientSecret?: string;
}

interface SecretsProvider {
  getSecrets(): Promise<AppSecrets>;
}

class EnvironmentSecretsProvider implements SecretsProvider {
  async getSecrets(): Promise<AppSecrets> {
    const cloudType = parseCloudType(process.env.MS365_ADMIN_MCP_CLOUD_TYPE);
    return {
      clientId: requiredEnv('MS365_ADMIN_MCP_CLIENT_ID'),
      tenantId: requiredEnv('MS365_ADMIN_MCP_TENANT_ID'),
      clientSecret: requiredEnv('MS365_ADMIN_MCP_CLIENT_SECRET'),
      cloudType,
      oauthClientId: process.env.MS365_ADMIN_MCP_OAUTH_CLIENT_ID?.trim() || undefined,
      oauthClientSecret: process.env.MS365_ADMIN_MCP_OAUTH_CLIENT_SECRET?.trim() || undefined,
    };
  }
}

class KeyVaultSecretsProvider implements SecretsProvider {
  private vaultUrl: string;

  constructor(vaultUrl: string) {
    this.vaultUrl = vaultUrl;
  }

  async getSecrets(): Promise<AppSecrets> {
    const { DefaultAzureCredential } = await import('@azure/identity');
    const { SecretClient } = await import('@azure/keyvault-secrets');

    const credential = new DefaultAzureCredential();
    const client = new SecretClient(this.vaultUrl, credential);

    logger.info(`Fetching secrets from Key Vault: ${this.vaultUrl}`);

    const [
      clientIdSecret,
      tenantIdSecret,
      clientSecretResult,
      cloudTypeResult,
      oauthClientIdResult,
      oauthClientSecretResult,
    ] = await Promise.all([
      client.getSecret('ms365-admin-mcp-client-id'),
      client.getSecret('ms365-admin-mcp-tenant-id'),
      client.getSecret('ms365-admin-mcp-client-secret').catch(() => null),
      client.getSecret('ms365-admin-mcp-cloud-type').catch(() => null),
      client.getSecret('ms365-admin-mcp-oauth-client-id').catch(() => null),
      client.getSecret('ms365-admin-mcp-oauth-client-secret').catch(() => null),
    ]);

    if (!clientIdSecret.value) {
      throw new Error('Required secret ms365-admin-mcp-client-id not found in Key Vault');
    }

    logger.info('Successfully retrieved secrets from Key Vault');

    return {
      clientId: clientIdSecret.value,
      tenantId: tenantIdSecret?.value || '',
      clientSecret: clientSecretResult?.value,
      cloudType: parseCloudType(cloudTypeResult?.value),
      oauthClientId: oauthClientIdResult?.value || undefined,
      oauthClientSecret: oauthClientSecretResult?.value || undefined,
    };
  }
}

function createSecretsProvider(): SecretsProvider {
  const vaultUrl = process.env.MS365_ADMIN_MCP_KEYVAULT_URL;

  if (vaultUrl) {
    logger.info('Key Vault URL configured, using Azure Key Vault for secrets');
    return new KeyVaultSecretsProvider(vaultUrl);
  }

  logger.info('Using environment variables for secrets');
  return new EnvironmentSecretsProvider();
}

let cachedSecrets: AppSecrets | null = null;

export async function getSecrets(): Promise<AppSecrets> {
  if (cachedSecrets) {
    return cachedSecrets;
  }

  const provider = createSecretsProvider();
  cachedSecrets = await provider.getSecrets();
  return cachedSecrets;
}

export function clearSecretsCache(): void {
  cachedSecrets = null;
}
