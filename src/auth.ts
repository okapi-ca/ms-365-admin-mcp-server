import type { Configuration } from '@azure/msal-node';
import { ConfidentialClientApplication } from '@azure/msal-node';
import logger from './logger.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import type { AppSecrets } from './secrets.js';
import { getCloudEndpoints } from './cloud-config.js';

interface EndpointConfig {
  pathPattern: string;
  method: string;
  toolName: string;
  appPermissions?: string[];
  llmTip?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const endpointsData = JSON.parse(
  readFileSync(path.join(__dirname, 'endpoints.json'), 'utf8')
) as EndpointConfig[];

const endpoints = {
  default: endpointsData,
};

function createMsalConfig(secrets: AppSecrets): Configuration {
  const cloudEndpoints = getCloudEndpoints(secrets.cloudType);
  return {
    auth: {
      clientId: secrets.clientId,
      clientSecret: secrets.clientSecret,
      authority: `${cloudEndpoints.authority}/${secrets.tenantId}`,
    },
  };
}

export function buildPermissionsFromEndpoints(
  enabledToolsPattern?: string,
  readOnly: boolean = false
): string[] {
  const permissionsSet = new Set<string>();

  let enabledToolsRegex: RegExp | undefined;
  if (enabledToolsPattern) {
    try {
      enabledToolsRegex = new RegExp(enabledToolsPattern, 'i');
    } catch {
      logger.error(`Invalid tool filter regex: ${enabledToolsPattern}`);
    }
  }

  endpoints.default.forEach((endpoint) => {
    if (readOnly && endpoint.method.toUpperCase() !== 'GET') {
      return;
    }
    if (enabledToolsRegex && !enabledToolsRegex.test(endpoint.toolName)) {
      return;
    }
    if (endpoint.appPermissions) {
      endpoint.appPermissions.forEach((p) => permissionsSet.add(p));
    }
  });

  return Array.from(permissionsSet);
}

class AuthManager {
  private msalApp: ConfidentialClientApplication;
  private secrets: AppSecrets;
  private accessToken: string | null = null;
  private tokenExpiry: number | null = null;

  constructor(config: Configuration, secrets: AppSecrets) {
    this.msalApp = new ConfidentialClientApplication(config);
    this.secrets = secrets;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  static async create(secrets: AppSecrets): Promise<AuthManager> {
    if (!secrets.clientId) {
      throw new Error(
        'MS365_ADMIN_MCP_CLIENT_ID is required. ' +
          'Register an app in Azure AD and provide the Application (client) ID.'
      );
    }
    if (!secrets.clientSecret) {
      throw new Error(
        'MS365_ADMIN_MCP_CLIENT_SECRET is required for client credentials flow. ' +
          'Register an app in Azure AD and provide a client secret.'
      );
    }
    if (!secrets.tenantId || secrets.tenantId === 'common') {
      throw new Error(
        'MS365_ADMIN_MCP_TENANT_ID must be a specific tenant ID (not "common"). ' +
          'Client credentials flow requires a single-tenant app registration.'
      );
    }
    const config = createMsalConfig(secrets);
    return new AuthManager(config, secrets);
  }

  async getToken(): Promise<string> {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry - 60_000) {
      return this.accessToken;
    }

    logger.info('Acquiring token via client credentials flow...');
    const result = await this.msalApp.acquireTokenByClientCredential({
      scopes: ['https://graph.microsoft.com/.default'],
    });

    if (!result) {
      throw new Error('Failed to acquire token via client credentials. Check client ID/secret.');
    }

    this.accessToken = result.accessToken;
    this.tokenExpiry = result.expiresOn?.getTime() ?? Date.now() + 3600 * 1000;
    logger.info('Token acquired successfully');
    return this.accessToken;
  }

  async testLogin(): Promise<{ success: boolean; message: string; tenantInfo?: unknown }> {
    try {
      const token = await this.getToken();
      const cloudEndpoints = getCloudEndpoints(this.secrets.cloudType);
      const response = await fetch(`${cloudEndpoints.graphApi}/v1.0/organization`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          message: `Graph API error: ${response.status} ${response.statusText} - ${errorText}`,
        };
      }

      const data = (await response.json()) as {
        value?: Array<{ displayName?: string; id?: string }>;
      };
      const org = data.value?.[0];
      return {
        success: true,
        message: `Connected to tenant: ${org?.displayName || 'Unknown'}`,
        tenantInfo: org,
      };
    } catch (error) {
      return {
        success: false,
        message: `Authentication failed: ${(error as Error).message}`,
      };
    }
  }
}

export default AuthManager;
