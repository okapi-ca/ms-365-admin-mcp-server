import logger from './logger.js';
import AuthManager from './auth.js';
import type { AppSecrets } from './secrets.js';
import { getCloudEndpoints } from './cloud-config.js';

interface GraphRequestOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  rawResponse?: boolean;
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
      logger.info(`Calling Graph API endpoint: ${endpoint.split('?')[0]}`);
      const result = await this.makeRequest(endpoint, options);
      return this.formatResponse(result, options.rawResponse, options.excludeResponse);
    } catch (error) {
      logger.error(`Error in Graph API request: ${(error as Error).message}`);
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

    // SEC: strip query string — can contain PII/UPN/secret IDs via $filter, etc.
    logger.debug(`[GRAPH CLIENT] Final URL: ${url.split('?')[0]}`);

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
      // SEC-B: Log full error for debugging but return sanitized message to client
      logger.error(`Graph API error ${response.status} on ${url.split('?')[0]}: ${errorText}`);
      let clientMessage = `Microsoft Graph API error: ${response.status} ${response.statusText}`;
      try {
        const parsed = JSON.parse(errorText) as { error?: { message?: string; code?: string } };
        if (parsed.error?.code) {
          clientMessage += ` (${parsed.error.code})`;
        }
        if (parsed.error?.message) {
          clientMessage += ` - ${parsed.error.message}`;
        }
      } catch {
        // Non-JSON error body — don't leak raw text
      }
      throw new Error(clientMessage);
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
