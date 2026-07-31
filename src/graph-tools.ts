import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import logger from './logger.js';
import GraphClient from './graph-client.js';
import { api } from './generated/client.js';
import { z } from 'zod';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { wrapUntrustedContent } from './untrusted-envelope.js';
import { effectiveRiskLevel, isToolAllowed, type RiskLevel } from './risk-level.js';
import {
  hasGuardrails,
  runGuardrails,
  type GraphReader,
  type GuardrailResult,
} from './guardrails.js';

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
  apiVersion?: 'v1.0' | 'beta';
}

// SEC-A (SEC-001): allowlist for skip-encoded path parameters. The previous
// denylist /[/\\?#&]|\.\./ accepted percent-encoded forms (%2E%2E, %2F, %5C)
// that Microsoft Graph normalises server-side, leaving a latent path-traversal
// vector for any future endpoint admitting a wider value space. The allowlist
// covers the only legitimate skipEncoding values today: 'period' (D7|D30|D90
// |D180) and ISO 8601 datetimes (fromDateTime/toDateTime). Endpoints needing a
// wider character set should declare a per-endpoint allowlist in endpoints.json
// rather than relax this default.
//
// Note: '.' is allowed (ISO 8601 fractional seconds need it), but two dots in a
// row are explicitly rejected — they have no legitimate use in current values
// and would re-enable literal path-traversal under the allowlist.
export const SKIP_ENCODING_ALLOWLIST = /^[A-Za-z0-9._:-]+$/;

export function validateSkipEncodingValue(paramName: string, raw: string): void {
  if (!SKIP_ENCODING_ALLOWLIST.test(raw) || raw.includes('..')) {
    throw new Error(
      `Invalid value for path parameter '${paramName}': contains disallowed characters`
    );
  }
}

// SEC-B (SEC-006): path-param encoding for non-skipEncoding params.
// Microsoft Graph function-style paths that need a literal 'arg=value'
// (getPstnCalls, getXxxActivityCounts, etc.) all declare 'skipEncoding'
// — so this helper never sees a legitimate '=' in rawValue. A previous
// .replace(/%3D/g, '=') was applied here and would have decoded user-
// supplied '=' (e.g. inside a crafted userId), creating a path-injection
// vector. Removed; full encodeURIComponent is the correct behavior.
export function encodePathParamValue(rawValue: string): string {
  return encodeURIComponent(rawValue);
}

// SEC-F (handoff Finding 3 + export-review-set follow-up): the generator emits
// imperfect Zod schemas for Graph request bodies, and over-strict local
// validation produced false rejections that blocked otherwise-valid requests.
// Two observed failure modes:
//
//  1. Recursive entity bodies are `z.lazy(() => z.object(...))`; some MCP clients
//     can't render a JSON Schema for a lazy parameter and downgrade the `body`
//     argument to a JSON *string* — rejected with "expected object, received
//     string" (e.g. create-ediscovery-search).
//  2. Graph flagged-enum fields nested inside a body (e.g. export-review-set's
//     `exportOptions`/`exportStructure`) are emitted as `object` but Graph
//     expects a comma-separated string — rejected with the same error, one level
//     deep, where a top-level string-parse can't help.
//
// Microsoft Graph is the authority on body validity, so this wrapper keeps the
// generated schema only as *guidance* (it still drives the tool's input hints)
// and never hard-rejects on it:
//   - a JSON-object/array *string* body is parsed first (mode 1), then
//   - validation accepts EITHER the generated schema (preferred) OR any value
//     (`z.any()`), so a payload that is valid for Graph but not for the imperfect
//     local schema passes through untouched (mode 2). executeGraphTool already
//     forwards the raw body on a strict-schema miss, so the round-trip is intact.
// Non-JSON / primitive strings are left as-is for raw text / binary bodies.
export function coerceJsonStringBody(schema: z.ZodTypeAny): z.ZodTypeAny {
  return z.preprocess(
    (val) => {
      if (typeof val !== 'string') return val;
      const trimmed = val.trim();
      if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return val;
      try {
        return JSON.parse(trimmed);
      } catch {
        return val;
      }
    },
    z.union([schema, z.any()])
  );
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

/**
 * Reader handed to the guardrail module. Two properties matter:
 *   - it rejects on a Graph error instead of resolving an isError envelope, so a
 *     failed pre-flight is distinguishable from an empty result;
 *   - it requests `rawResponse`, keeping `@odata.type` intact — the
 *     last-Global-Admin count needs it to tell a role-assignable group holding
 *     the role apart from a disabled user.
 */
function makeGuardrailReader(graphClient: GraphClient): GraphReader {
  return async (endpoint: string) => {
    const result = (await graphClient.graphRequest(endpoint, {
      rawResponse: true,
    })) as CallToolResult;
    const text = result.content?.[0]?.text ?? '';

    if (result.isError) {
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === 'string') detail = parsed.error;
      } catch {
        // Keep the raw text as the failure detail.
      }
      throw new Error(detail);
    }

    return JSON.parse(text) as Record<string, unknown>;
  };
}

/**
 * Guardrail check 5: Graph answered the write with a 403 and the pre-flight
 * gathered context that explains why. Append it to the error the operator sees
 * rather than relaying the bare denial.
 */
function appendErrorHints(result: CallToolResult, hints: string[]): CallToolResult {
  const text = result.content?.[0]?.text ?? '';
  if (!text.includes('403')) return result;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return result;
  }

  return {
    ...result,
    content: [
      { type: 'text', text: JSON.stringify({ ...payload, guardrailContext: hints }) },
      ...result.content.slice(1),
    ],
  };
}

async function executeGraphTool(
  tool: (typeof api.endpoints)[0],
  config: EndpointConfig | undefined,
  graphClient: GraphClient,
  params: Record<string, unknown>
): Promise<CallToolResult> {
  logger.info(`Tool ${tool.alias} called with params: [${Object.keys(params).join(', ')}]`);
  try {
    // Pre-flight guardrails for privilege-revocation tools — see guardrails.ts
    // for the five checks and their per-check failure posture. A block never
    // reaches Graph; the result is server-generated, so it bypasses the
    // untrusted-content envelope like any other error.
    let guardrail: GuardrailResult | undefined;
    if (hasGuardrails(tool.alias)) {
      guardrail = await runGuardrails(tool.alias, params, makeGuardrailReader(graphClient));
      if (guardrail.blocked) {
        logger.warn(`Guardrail blocked ${tool.alias}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: guardrail.reason, guardrail: tool.alias }),
            },
          ],
          isError: true,
        };
      }
    }

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
              // SEC-A (SEC-001): allowlist validation — see validateSkipEncodingValue.
              const raw = paramValue as string;
              validateSkipEncodingValue(paramName, raw);
              encodedValue = raw;
            } else {
              // SEC-B (SEC-006): see encodePathParamValue for rationale.
              encodedValue = encodePathParamValue(paramValue as string);
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
            // SEC-F2: forward the caller's payload verbatim. Microsoft Graph is the
            // authority on body validity — see coerceJsonStringBody above for why the
            // generated schema is guidance only — so a local parse result has nothing
            // useful to contribute here.
            //
            // A previous revision, on a schema miss, re-parsed the payload wrapped as
            // `{ [paramName]: payload }` and sent that whenever the wrapped form
            // validated. Every generated Body parameter is named `body`, so the wrapped
            // form is `{ body: … }` — a shape no Graph resource accepts. It fired on all
            // six POST …/$ref endpoints, whose generated schema is
            // `z.record(z.object({}).partial().passthrough())`: the real payload
            // `{ "@odata.id": "https://…" }` FAILS that record because the value is a
            // string, while `{ body: { "@odata.id": … } }` PASSES because the value is an
            // object. The wrap therefore won by accident and Graph answered
            // 400 Request_BadRequest, "An unexpected 'EndOfInput' node was found when
            // reading from the JSON reader. A 'StartObject' node was expected."
            //
            // add-group-member, add-directory-role-member, add-administrative-unit-member,
            // add-application-owner and add-sp-owner were all unusable as a result — five
            // pre-existing tools, silently broken. Surfaced by replaying a real
            // offboarding end to end against the tenant rather than by any unit test,
            // because no test asserted the bytes on the wire.
            body = paramValue;
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

    if (config?.apiVersion) {
      requestOptions.apiVersion = config.apiVersion;
    }

    if (body !== null) {
      requestOptions.body = JSON.stringify(body);
      if (config?.contentType) {
        headers['Content-Type'] = config.contentType;
      }
    }

    // SEC-G02: wrap Graph response in an untrusted-content envelope before it
    // becomes part of the LLM context. Errors pass through unchanged.
    let graphResult = (await graphClient.graphRequest(fullPath, requestOptions)) as CallToolResult;

    if (graphResult.isError && guardrail && guardrail.errorHints.length > 0) {
      graphResult = appendErrorHints(graphResult, guardrail.errorHints);
    }

    const wrapped = wrapUntrustedContent(graphResult, tool.alias);

    // A guardrail notice is server-generated, so it is prepended *outside* the
    // envelope — inside it, the preamble would label our own warning untrusted.
    if (guardrail && guardrail.notices.length > 0) {
      return {
        ...wrapped,
        content: [
          { type: 'text' as const, text: guardrail.notices.join('\n\n') },
          ...wrapped.content,
        ],
      };
    }

    return wrapped;
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
  appOnlyGraphClient?: GraphClient,
  writeRiskTiers?: Set<RiskLevel>
): number {
  let registeredCount = 0;
  let skippedCount = 0;
  let skippedByRisk = 0;
  let skippedByRole = 0;
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

    // Per-caller write tier filter (HTTP mode with Entra App Roles).
    // `writeRiskTiers === undefined` means "no per-caller filter" (stdio, or
    // server started without role-based gating) — preserve legacy behavior.
    // A non-undefined Set is authoritative: writes whose effective tier is
    // absent from the set are not registered for this caller.
    if (writeRiskTiers !== undefined && tool.method.toUpperCase() !== 'GET') {
      const tier = effectiveRiskLevel(endpointConfig?.riskLevel, tool.method);
      if (!writeRiskTiers.has(tier)) {
        skippedByRole++;
        continue;
      }
    }

    if (enabledToolsRegex && !enabledToolsRegex.test(tool.alias)) {
      skippedCount++;
      continue;
    }

    // Build parameter schema from the generated client tool definition
    const paramSchema: Record<string, z.ZodTypeAny> = {};
    for (const param of tool.parameters || []) {
      if (param.type === 'Body') {
        paramSchema[param.name] = coerceJsonStringBody(param.schema || z.unknown()).optional();
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
    const clientForTool = requiresAppOnly && appOnlyGraphClient ? appOnlyGraphClient : graphClient;

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

  const roleSummary = writeRiskTiers
    ? `, ${skippedByRole} skipped (role tiers: ${[...writeRiskTiers].join('|') || 'none'})`
    : '';
  logger.info(
    `Tool registration complete: ${registeredCount} registered, ${skippedCount} skipped (read-only/filter), ${skippedByRisk} skipped (risk-level cap: ${maxRiskLevel})${roleSummary}, ${failedCount} failed`
  );
  return registeredCount;
}
