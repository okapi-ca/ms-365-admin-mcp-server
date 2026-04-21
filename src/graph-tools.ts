import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import logger from './logger.js';
import GraphClient from './graph-client.js';
import { api } from './generated/client.js';
import { z } from 'zod';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { wrapUntrustedContent } from './untrusted-envelope.js';
import { isToolAllowed, type RiskLevel } from './risk-level.js';

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

// Permissions that have no delegated equivalent in Microsoft Graph.
// Tools requiring any of these permissions must use an app-only token even in
// OBO mode, because the user token cannot be exchanged for one of these scopes.
const APP_ONLY_PERMISSIONS = new Set([
  // Confirmed app-only by conception
  'BitlockerKey.Read.All',
  'DeviceLocalCredential.Read.All',
  'OnPremDirectorySynchronization.Read.All',
  'Exchange.ManageAsApp',
  'SecurityIdentitiesHealth.Read.All',
  'ThreatHunting.Read.All',
  'CopilotSettings-Internal.ReadWrite.All',
  'PrintConnector.Read.All',
  // Not found as delegated in Graph SP oauth2PermissionScopes (confirmed during CYSEC-1424)
  'AppRoleAssignment.Read.All',
  'CallRecords.Read.All',
  'Device.ReadWrite.All',
  'InformationProtectionPolicy.Read.All',
  'Team.ReadWrite.All',
  'ThreatAssessment.Read.All',
]);

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
      if (paramName === 'excludeResponse') {
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
            let encodedValue: string;
            if (shouldSkipEncoding) {
              // SEC-A: Validate skip-encoded params to prevent path traversal
              const raw = paramValue as string;
              if (/[/\\?#&]|\.\./.test(raw)) {
                throw new Error(
                  `Invalid value for path parameter '${paramName}': contains disallowed characters`
                );
              }
              encodedValue = raw;
            } else {
              encodedValue = encodeURIComponent(paramValue as string).replace(/%3D/g, '=');
            }

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
      excludeResponse: !!params.excludeResponse,
    };

    if (body !== null) {
      requestOptions.body = JSON.stringify(body);
      if (config?.contentType) {
        headers['Content-Type'] = config.contentType;
      }
    }

    // SEC-G02: wrap Graph response in an untrusted-content envelope before it
    // becomes part of the LLM context. Errors pass through unchanged.
    const graphResult = (await graphClient.graphRequest(
      fullPath,
      requestOptions
    )) as CallToolResult;
    return wrapUntrustedContent(graphResult, tool.alias);
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
  enabledToolsPattern?: string,
  maxRiskLevel: RiskLevel = 'critical',
  appOnlyGraphClient?: GraphClient
): number {
  let registeredCount = 0;
  let skippedCount = 0;
  let skippedByRisk = 0;
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

    // SEC-G01: cap tool registration by risk level. Applies to both reads and writes.
    // Sensitive-read GETs annotated with a riskLevel (SEC-G03) are also filtered here.
    if (!isToolAllowed(endpointConfig?.riskLevel, tool.method, maxRiskLevel)) {
      skippedByRisk++;
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
      // SEC-G03: read-operation risk copy differs from write-operation copy.
      const isWrite = tool.method.toUpperCase() !== 'GET';
      let riskCopy = '';
      if (isWrite) {
        if (endpointConfig.riskLevel === 'critical') {
          riskCopy =
            'This action is irreversible or has major security impact. Always confirm with the operator before executing.';
        } else if (endpointConfig.riskLevel === 'high') {
          riskCopy =
            'This action has significant impact. Verify the target carefully before executing.';
        }
      } else {
        if (endpointConfig.riskLevel === 'high') {
          riskCopy =
            'This response contains secrets or highly sensitive data (e.g. recovery keys, LAPS passwords, legal-hold material). Do not echo verbatim; confirm with the operator before sharing.';
        } else if (endpointConfig.riskLevel === 'medium') {
          riskCopy =
            'This response contains PII or authentication metadata (sign-ins, MFA factors, mail metadata, risk detections). Handle with care and avoid casual disclosure.';
        }
      }
      toolDescription += `\n\nRISK LEVEL: ${endpointConfig.riskLevel.toUpperCase()}. ${riskCopy}`;
    }

    const requiresAppOnly =
      endpointConfig?.appPermissions?.some((p) => APP_ONLY_PERMISSIONS.has(p)) ?? false;
    const clientForTool =
      requiresAppOnly && appOnlyGraphClient ? appOnlyGraphClient : graphClient;

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
        async (params) => executeGraphTool(tool, endpointConfig, clientForTool, params)
      );
      registeredCount++;
    } catch (error) {
      logger.error(`Failed to register tool ${tool.alias}: ${(error as Error).message}`);
      failedCount++;
    }
  }

  logger.info(
    `Tool registration complete: ${registeredCount} registered, ${skippedCount} skipped (read-only/filter), ${skippedByRisk} skipped (risk-level cap: ${maxRiskLevel}), ${failedCount} failed`
  );
  return registeredCount;
}
