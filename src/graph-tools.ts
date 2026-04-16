import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import logger from './logger.js';
import GraphClient from './graph-client.js';
import { api } from './generated/client.js';
import { z } from 'zod';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface EndpointConfig {
  pathPattern: string;
  method: string;
  toolName: string;
  appPermissions?: string[];
  llmTip?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  skipEncoding?: string[];
  contentType?: string;
  acceptType?: string;
  returnDownloadUrl?: boolean;
}

const endpointsData = JSON.parse(
  readFileSync(path.join(__dirname, 'endpoints.json'), 'utf8')
) as EndpointConfig[];

function maxTopFromEnv(): number | undefined {
  const raw = process.env.MS365_ADMIN_MCP_MAX_TOP;
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    logger.warn(`Ignoring invalid MS365_ADMIN_MCP_MAX_TOP=${JSON.stringify(raw)}`);
    return undefined;
  }
  return n;
}

function clampTopQueryParam(queryParams: Record<string, string>): void {
  const cap = maxTopFromEnv();
  if (cap === undefined || queryParams['$top'] === undefined) return;
  const requested = Number.parseInt(queryParams['$top'], 10);
  if (!Number.isFinite(requested) || requested <= cap) return;
  logger.info(`Clamping $top from ${requested} to ${cap}`);
  queryParams['$top'] = String(cap);
}

type ContentItem = {
  type: 'text';
  text: string;
  [key: string]: unknown;
};

interface CallToolResult {
  content: ContentItem[];
  isError?: boolean;
  [key: string]: unknown;
}

async function executeGraphTool(
  tool: (typeof api.endpoints)[0],
  config: EndpointConfig | undefined,
  graphClient: GraphClient,
  params: Record<string, unknown>
): Promise<CallToolResult> {
  logger.info(`Tool ${tool.alias} called with params: [${Object.keys(params).join(', ')}]`);
  try {
    const parameterDefinitions = tool.parameters || [];

    let path = tool.path;
    const queryParams: Record<string, string> = {};
    const headers: Record<string, string> = {};
    let body: unknown = null;

    for (const [paramName, paramValue] of Object.entries(params)) {
      if (['includeHeaders', 'excludeResponse'].includes(paramName)) {
        continue;
      }

      const odataParams = [
        'filter',
        'select',
        'expand',
        'orderby',
        'skip',
        'top',
        'count',
        'search',
        'format',
      ];
      const normalizedParamName = paramName.startsWith('$') ? paramName.slice(1) : paramName;
      const isOdataParam = odataParams.includes(normalizedParamName.toLowerCase());
      const fixedParamName = isOdataParam ? `$${normalizedParamName.toLowerCase()}` : paramName;
      const camelCaseParamName = paramName.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

      const paramDef = parameterDefinitions.find(
        (p) =>
          p.name === paramName ||
          p.name === camelCaseParamName ||
          (isOdataParam && p.name === normalizedParamName)
      );

      if (paramDef) {
        switch (paramDef.type) {
          case 'Path': {
            const shouldSkipEncoding = config?.skipEncoding?.includes(paramName) ?? false;
            const encodedValue = shouldSkipEncoding
              ? (paramValue as string)
              : encodeURIComponent(paramValue as string).replace(/%3D/g, '=');

            path = path
              .replace(`{${paramName}}`, encodedValue)
              .replace(`:${paramName}`, encodedValue)
              .replace(`{${camelCaseParamName}}`, encodedValue)
              .replace(`:${camelCaseParamName}`, encodedValue);
            break;
          }
          case 'Query':
            if (paramValue !== '' && paramValue != null) {
              queryParams[fixedParamName] = `${paramValue}`;
            }
            break;
          case 'Body':
            if (paramDef.schema) {
              const parseResult = paramDef.schema.safeParse(paramValue);
              if (!parseResult.success) {
                const wrapped = { [paramName]: paramValue };
                const wrappedResult = paramDef.schema.safeParse(wrapped);
                if (wrappedResult.success) {
                  body = wrapped;
                } else {
                  body = paramValue;
                }
              } else {
                body = paramValue;
              }
            } else {
              body = paramValue;
            }
            break;
          case 'Header':
            headers[fixedParamName] = `${paramValue}`;
            break;
        }
      } else if (paramName === 'body') {
        body = paramValue;
      } else if (
        path.includes(`:${paramName}`) ||
        path.includes(`{${paramName}}`) ||
        path.includes(`:${camelCaseParamName}`) ||
        path.includes(`{${camelCaseParamName}}`)
      ) {
        const encodedValue = encodeURIComponent(paramValue as string).replace(/%3D/g, '=');
        path = path
          .replace(`{${paramName}}`, encodedValue)
          .replace(`:${paramName}`, encodedValue)
          .replace(`{${camelCaseParamName}}`, encodedValue)
          .replace(`:${camelCaseParamName}`, encodedValue);
      }
    }

    clampTopQueryParam(queryParams);

    if (config?.acceptType) {
      headers['Accept'] = config.acceptType;
    }

    const queryString = Object.entries(queryParams)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');

    const fullPath = queryString ? `${path}?${queryString}` : path;

    const requestOptions: Record<string, unknown> = {
      method: tool.method.toUpperCase(),
      headers,
      rawResponse: !!config?.acceptType || !!config?.returnDownloadUrl,
      includeHeaders: !!params.includeHeaders,
      excludeResponse: !!params.excludeResponse,
    };

    if (body !== null) {
      requestOptions.body = JSON.stringify(body);
      if (config?.contentType) {
        headers['Content-Type'] = config.contentType;
      }
    }

    return (await graphClient.graphRequest(fullPath, requestOptions)) as CallToolResult;
  } catch (error) {
    logger.error(`Error executing tool ${tool.alias}: ${(error as Error).message}`);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: (error as Error).message }) }],
      isError: true,
    };
  }
}

export function registerGraphTools(
  server: McpServer,
  graphClient: GraphClient,
  readOnly: boolean = false,
  enabledToolsPattern?: string
): number {
  let registeredCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  let enabledToolsRegex: RegExp | undefined;
  if (enabledToolsPattern) {
    try {
      enabledToolsRegex = new RegExp(enabledToolsPattern, 'i');
    } catch {
      logger.error(`Invalid tool filter regex: ${enabledToolsPattern}`);
    }
  }

  for (const tool of api.endpoints) {
    const endpointConfig = endpointsData.find((e) => e.toolName === tool.alias);

    if (readOnly && tool.method.toUpperCase() !== 'GET') {
      skippedCount++;
      continue;
    }

    if (enabledToolsRegex && !enabledToolsRegex.test(tool.alias)) {
      skippedCount++;
      continue;
    }

    // Build parameter schema from the generated client tool definition
    const paramSchema: Record<string, z.ZodTypeAny> = {};
    for (const param of tool.parameters || []) {
      if (param.type === 'Body') {
        paramSchema[param.name] = (param.schema || z.unknown()).optional();
      } else if (param.type === 'Path') {
        paramSchema[param.name] = z.string().describe(param.description || param.name);
      } else if (param.type === 'Query') {
        paramSchema[param.name] = z
          .string()
          .describe(param.description || param.name)
          .optional();
      } else if (param.type === 'Header') {
        paramSchema[param.name] = z
          .string()
          .describe(param.description || param.name)
          .optional();
      }
    }

    // Improve OData parameter descriptions
    if (paramSchema['filter'] !== undefined || paramSchema['$filter'] !== undefined) {
      const key = paramSchema['$filter'] !== undefined ? '$filter' : 'filter';
      paramSchema[key] = z
        .string()
        .describe("OData $filter expression, e.g. status eq 'inProgress'")
        .optional();
    }
    if (paramSchema['select'] !== undefined || paramSchema['$select'] !== undefined) {
      const key = paramSchema['$select'] !== undefined ? '$select' : 'select';
      paramSchema[key] = z.string().describe('Comma-separated fields to return').optional();
    }
    if (paramSchema['top'] !== undefined || paramSchema['$top'] !== undefined) {
      const key = paramSchema['$top'] !== undefined ? '$top' : 'top';
      paramSchema[key] = z
        .number()
        .describe(
          'Page size (Graph $top). Start small (5-15) so responses fit the model context. ' +
            'Use @odata.nextLink from the response for more rows.'
        )
        .optional();
    }

    paramSchema['excludeResponse'] = z
      .boolean()
      .describe('Exclude the full response body and only return success or failure')
      .optional();

    let toolDescription =
      tool.description || `Execute ${tool.method.toUpperCase()} request to ${tool.path}`;
    if (endpointConfig?.llmTip) {
      toolDescription += `\n\nTIP: ${endpointConfig.llmTip}`;
    }
    if (endpointConfig?.riskLevel) {
      toolDescription += `\n\nRISK LEVEL: ${endpointConfig.riskLevel.toUpperCase()}. ${
        endpointConfig.riskLevel === 'critical'
          ? 'This action is irreversible or has major security impact. Always confirm with the operator before executing.'
          : endpointConfig.riskLevel === 'high'
            ? 'This action has significant impact. Verify the target carefully before executing.'
            : ''
      }`;
    }

    try {
      server.tool(
        tool.alias,
        toolDescription,
        paramSchema,
        {
          title: tool.alias,
          readOnlyHint: tool.method.toUpperCase() === 'GET',
          destructiveHint: ['POST', 'PATCH', 'DELETE'].includes(tool.method.toUpperCase()),
          openWorldHint: true,
        },
        async (params) => executeGraphTool(tool, endpointConfig, graphClient, params)
      );
      registeredCount++;
    } catch (error) {
      logger.error(`Failed to register tool ${tool.alias}: ${(error as Error).message}`);
      failedCount++;
    }
  }

  logger.info(
    `Tool registration complete: ${registeredCount} registered, ${skippedCount} skipped, ${failedCount} failed`
  );
  return registeredCount;
}
