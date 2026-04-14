import logger from './logger.js';
import AuthManager from './auth.js';
import type { AppSecrets } from './secrets.js';
import { getCloudEndpoints } from './cloud-config.js';

interface GraphRequestOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  rawResponse?: boolean;
  includeHeaders?: boolean;
  excludeResponse?: boolean;
}

interface ContentItem {
  type: 'text';
  text: string;
  [key: string]: unknown;
}

interface McpResponse {
  content: ContentItem[];
  isError?: boolean;
  [key: string]: unknown;
}

class GraphClient {
  private authManager: AuthManager;
  private secrets: AppSecrets;

  constructor(authManager: AuthManager, secrets: AppSecrets) {
    this.authManager = authManager;
    this.secrets = secrets;
  }

  async graphRequest(endpoint: string, options: GraphRequestOptions = {}): Promise<McpResponse> {
    try {
      logger.info(`Calling ${endpoint}`);
      const result = await this.makeRequest(endpoint, options);
      return this.formatResponse(result, options.rawResponse, options.excludeResponse);
    } catch (error) {
      logger.error(`Error in Graph API request: ${error}`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: (error as Error).message }) }],
        isError: true,
      };
    }
  }

  private async makeRequest(endpoint: string, options: GraphRequestOptions = {}): Promise<unknown> {
    const accessToken = await this.authManager.getToken();
    const cloudEndpoints = getCloudEndpoints(this.secrets.cloudType);
    const url = `${cloudEndpoints.graphApi}/v1.0${endpoint}`;

    logger.info(`[GRAPH CLIENT] Final URL: ${url}`);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Microsoft Graph API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const text = await response.text();
    if (text === '') {
      return { message: 'OK!' };
    }

    try {
      return JSON.parse(text);
    } catch {
      return { message: 'OK!', rawResponse: text };
    }
  }

  private formatResponse(data: unknown, rawResponse = false, excludeResponse = false): McpResponse {
    if (excludeResponse) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      };
    }

    if (rawResponse) {
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
      };
    }

    if (data === null || data === undefined) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      };
    }

    // Remove OData properties
    const removeODataProps = (obj: Record<string, unknown>): void => {
      if (typeof obj === 'object' && obj !== null) {
        Object.keys(obj).forEach((key) => {
          if (key.startsWith('@odata.') && key !== '@odata.nextLink') {
            delete obj[key];
          } else if (typeof obj[key] === 'object') {
            removeODataProps(obj[key] as Record<string, unknown>);
          }
        });
      }
    };

    removeODataProps(data as Record<string, unknown>);

    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  }
}

export default GraphClient;
