import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import {
  ListToolsRequestSchema,
  type Tool,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import logger from './logger.js';
import GraphClient from './graph-client.js';
import { api } from './generated/client.js';
import { z } from 'zod';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { wrapUntrustedContent } from './untrusted-envelope.js';
import { shallowBodySchema } from './advertised-schema.js';
import { effectiveRiskLevel, isToolAllowed, type RiskLevel } from './risk-level.js';
import {
  collectReportPages,
  initialSkip,
  reportMaxRowsFromEnv,
  type ReportPage,
} from './report-pagination.js';
import {
  hasGuardrails,
  runGuardrails,
  type GraphReader,
  type GuardrailResult,
} from './guardrails.js';
import { compositeTools, type CompositeTool } from './composite-tools.js';
import { isOutputShape, OUTPUT_SHAPES, shapeResponseText } from './output-shape.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface EndpointConfig {
  pathPattern: string;
  method: string;
  toolName: string;
  /** README inventory section; tool-partitions.ts groups tools by it. */
  section: string;
  appPermissions?: string[];
  llmTip?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  skipEncoding?: string[];
  contentType?: string;
  acceptType?: string;
  returnDownloadUrl?: boolean;
  apiVersion?: 'v1.0' | 'beta';
  /** Tabular Intune report action: accepts allPages / dedupeBy (report-pagination.ts). */
  reportPagination?: boolean;
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

const endpointConfigByTool = new Map(endpointsData.map((e) => [e.toolName, e]));

/** Each tool with its README section — the input to `resolvePartition`. */
export function endpointSections(): { toolName: string; section: string }[] {
  return [...endpointsData, ...compositeTools].map(({ toolName, section }) => ({
    toolName,
    section,
  }));
}

/**
 * Tools that accept `shape` (output-shape.ts): reads of a collection. A path
 * ending in `}` addresses one entity, one ending in `)` is a function-style
 * report (often CSV); download and raw-Accept endpoints return no JSON to shape.
 */
export function acceptsOutputShape(config: EndpointConfig | undefined): boolean {
  return (
    config !== undefined &&
    config.method.toLowerCase() === 'get' &&
    !/[})]$/.test(config.pathPattern) &&
    !config.acceptType &&
    !config.returnDownloadUrl
  );
}

// One schema instance shared by every tool that takes the parameter. The text is
// repeated in ~300 tool schemas, so every character costs ~300 bytes of budget.
const outputShapeParam = z
  .enum(OUTPUT_SHAPES)
  .describe(
    'For long lists. compact: drop null/empty fields. table: compact, rows as arrays + columns.'
  )
  .optional();

/** Applies `shape` to a successful result; anything else passes through. */
function applyOutputShape(
  result: CallToolResult,
  shape: unknown,
  listKey?: string
): CallToolResult {
  if (result.isError || !isOutputShape(shape)) return result;
  return {
    ...result,
    content: result.content.map((item) =>
      item.type === 'text' ? { ...item, text: shapeResponseText(item.text, shape, listKey) } : item
    ),
  };
}

/** One group of a tool partition, as served on `/mcp/<group>`. */
export interface ToolGroupFilter {
  name: string;
  tools: ReadonlySet<string>;
}

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
  // Not found as delegated in Graph SP oauth2PermissionScopes (confirmed when the
  // delegated-consent rollout tried to grant them)
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

function parseReportPage(result: CallToolResult): ReportPage {
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) throw new Error(text);
  return JSON.parse(text) as ReportPage;
}

/**
 * Walks the remaining pages of a tabular Intune report — see
 * report-pagination.ts. The merged table replaces the first page before the
 * untrusted-content envelope is applied, so every row is still wrapped.
 */
async function paginateReport(
  first: CallToolResult,
  body: Record<string, unknown>,
  fullPath: string,
  requestOptions: Record<string, unknown>,
  graphClient: GraphClient,
  dedupeBy: string | undefined
): Promise<CallToolResult> {
  const merged = await collectReportPages(
    parseReportPage(first),
    initialSkip(body),
    async (skip) =>
      parseReportPage(
        (await graphClient.graphRequest(fullPath, {
          ...requestOptions,
          body: JSON.stringify({ ...body, skip }),
        })) as CallToolResult
      ),
    { dedupeBy, maxRows: reportMaxRowsFromEnv() }
  );
  logger.info(
    `Report paginated: ${merged.pagination.pagesFetched} page(s), ${merged.pagination.rowsReturned} row(s)`
  );
  return { content: [{ type: 'text', text: JSON.stringify(merged) }] };
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
      if (
        paramName === 'excludeResponse' ||
        (paramName === 'shape' && acceptsOutputShape(config)) ||
        (config?.reportPagination && (paramName === 'allPages' || paramName === 'dedupeBy'))
      ) {
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

    if (
      config?.reportPagination &&
      params.allPages === true &&
      !params.excludeResponse &&
      !graphResult.isError &&
      body !== null &&
      typeof body === 'object' &&
      !Array.isArray(body)
    ) {
      graphResult = await paginateReport(
        graphResult,
        body as Record<string, unknown>,
        fullPath,
        requestOptions,
        graphClient,
        typeof params.dedupeBy === 'string' && params.dedupeBy !== '' ? params.dedupeBy : undefined
      );
    }

    if (graphResult.isError && guardrail && guardrail.errorHints.length > 0) {
      graphResult = appendErrorHints(graphResult, guardrail.errorHints);
    }

    if (acceptsOutputShape(config) && !params.excludeResponse) {
      graphResult = applyOutputShape(graphResult, params.shape);
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

/**
 * Runs a composite tool (composite-tools.ts) under the same contract as
 * executeGraphTool: parameter names logged, never values; a successful result
 * wrapped in the untrusted-content envelope; a failure returned as an error.
 */
async function executeCompositeTool(
  composite: CompositeTool,
  graphClient: GraphClient,
  params: Record<string, unknown>
): Promise<CallToolResult> {
  logger.info(`Tool ${composite.toolName} called with params: [${Object.keys(params).join(', ')}]`);
  try {
    const result = await composite.run(graphClient, params);
    return wrapUntrustedContent(
      composite.listKey ? applyOutputShape(result, params.shape, composite.listKey) : result,
      composite.toolName
    );
  } catch (error) {
    logger.error(`Error executing tool ${composite.toolName}: ${(error as Error).message}`);
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
  writeRiskTiers?: Set<RiskLevel>,
  group?: ToolGroupFilter
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

  const registeredTools: [CatalogEntry, RegisteredTool][] = [];

  // Every tool, generated or composite, passes the same controls in this order.
  const admit = (alias: string, method: string, riskLevel: RiskLevel | undefined): boolean => {
    if (readOnly && method.toUpperCase() !== 'GET') {
      skippedCount++;
      return false;
    }

    // SEC-G01: cap tool registration by risk level. Applies to both reads and writes.
    // Sensitive-read GETs annotated with a riskLevel (SEC-G03) are also filtered here.
    if (!isToolAllowed(riskLevel, method, maxRiskLevel)) {
      skippedByRisk++;
      return false;
    }

    // Per-caller write tier filter (HTTP mode with Entra App Roles).
    // `writeRiskTiers === undefined` means "no per-caller filter" (stdio, or
    // server started without role-based gating) — preserve legacy behavior.
    // A non-undefined Set is authoritative: writes whose effective tier is
    // absent from the set are not registered for this caller.
    if (writeRiskTiers !== undefined && method.toUpperCase() !== 'GET') {
      const tier = effectiveRiskLevel(riskLevel, method);
      if (!writeRiskTiers.has(tier)) {
        skippedByRole++;
        return false;
      }
    }

    if (enabledToolsRegex && !enabledToolsRegex.test(alias)) {
      skippedCount++;
      return false;
    }

    // Per-group endpoint (`/mcp/<group>`): narrows the catalog, never widens
    // it — every control above has already run. `undefined` serves the full
    // catalog, as `/mcp` and stdio always have.
    if (group !== undefined && !group.tools.has(alias)) {
      skippedCount++;
      return false;
    }

    return true;
  };

  for (const tool of api.endpoints) {
    const endpointConfig = endpointConfigByTool.get(tool.alias);
    if (!admit(tool.alias, tool.method, endpointConfig?.riskLevel)) continue;

    const entry = catalogEntry(tool, endpointConfig);
    const clientForTool =
      entry.requiresAppOnly && appOnlyGraphClient ? appOnlyGraphClient : graphClient;

    try {
      const registered = server.tool(
        tool.alias,
        entry.description,
        entry.inputShape,
        entry.annotations,
        async (params) => executeGraphTool(tool, endpointConfig, clientForTool, params)
      );
      registeredTools.push([entry, registered]);
      registeredCount++;
    } catch (error) {
      logger.error(`Failed to register tool ${tool.alias}: ${(error as Error).message}`);
      failedCount++;
    }
  }

  for (const composite of compositeTools) {
    if (!admit(composite.toolName, composite.method, composite.riskLevel)) continue;

    const entry = compositeCatalogEntry(composite);
    const clientForTool =
      entry.requiresAppOnly && appOnlyGraphClient ? appOnlyGraphClient : graphClient;

    try {
      const registered = server.tool(
        composite.toolName,
        entry.description,
        entry.inputShape,
        entry.annotations,
        async (params) => executeCompositeTool(composite, clientForTool, params)
      );
      registeredTools.push([entry, registered]);
      registeredCount++;
    } catch (error) {
      logger.error(`Failed to register tool ${composite.toolName}: ${(error as Error).message}`);
      failedCount++;
    }
  }

  if (registeredTools.length > 0) {
    // Replaces the SDK's tools/list handler, which re-derives the JSON Schema of
    // every registered tool on every call: ~210 ms of CPU and a heap spike per
    // request for the full catalog. The cached listing is the SDK's own output
    // (see toolListing), so the wire format is unchanged. Like the SDK's handler,
    // it lists only enabled tools, so RegisteredTool.disable() keeps working.
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: registeredTools
        .filter(([, registered]) => registered.enabled)
        .map(([entry, registered]) => toolListing(entry, registered)),
    }));
  }

  const roleSummary = writeRiskTiers
    ? `, ${skippedByRole} skipped (role tiers: ${[...writeRiskTiers].join('|') || 'none'})`
    : '';
  const groupSummary = group ? ` [group: ${group.name}]` : '';
  logger.info(
    `Tool registration complete${groupSummary}: ${registeredCount} registered, ${skippedCount} skipped (read-only/filter), ${skippedByRisk} skipped (risk-level cap: ${maxRiskLevel})${roleSummary}, ${failedCount} failed`
  );
  return registeredCount;
}

/**
 * The caller-independent half of a tool: its input schema, description and
 * annotations, built once per process and shared by every McpServer.
 *
 * In HTTP mode a fresh McpServer is created per request. Rebuilding these for
 * the full catalog retained ~92 MB per server, so a handful of concurrent
 * tools/list calls exhausted the ~512 MB heap Node derives from a 2 Gi
 * container and crashed the process. Only the per-caller decisions —
 * which tools pass the filters, which GraphClient runs them — stay in
 * registerGraphTools.
 */
interface CatalogEntry {
  name: string;
  description: string;
  inputShape: Record<string, z.ZodTypeAny>;
  annotations: ToolAnnotations;
  requiresAppOnly: boolean;
  /** tools/list entry, derived on first listing. */
  listing?: Tool;
}

const catalog = new Map<string, CatalogEntry>();

// Same literal as the SDK's EMPTY_OBJECT_JSON_SCHEMA (not exported).
const EMPTY_OBJECT_JSON_SCHEMA = { type: 'object' as const, properties: {} };

function catalogEntry(
  tool: (typeof api.endpoints)[0],
  endpointConfig: EndpointConfig | undefined
): CatalogEntry {
  const cached = catalog.get(tool.alias);
  if (cached) return cached;
  const entry = buildCatalogEntry(tool, endpointConfig);
  catalog.set(tool.alias, entry);
  return entry;
}

function compositeCatalogEntry(composite: CompositeTool): CatalogEntry {
  const cached = catalog.get(composite.toolName);
  if (cached) return cached;
  const entry: CatalogEntry = {
    name: composite.toolName,
    description: describeTool(composite.description, composite, composite.method),
    inputShape: composite.listKey
      ? { ...composite.inputShape, shape: outputShapeParam }
      : composite.inputShape,
    annotations: toolAnnotations(composite.toolName, composite.method),
    requiresAppOnly: requiresAppOnly(composite.appPermissions),
  };
  catalog.set(composite.toolName, entry);
  return entry;
}

/**
 * The tools/list entry the SDK would emit for `registered`, computed once per
 * tool: every field it reads comes from the shared catalog entry, so the result
 * is the same for every caller. The body mirrors McpServer's own handler
 * (setToolRequestHandlers); test/graph-tools-catalog.test.ts compares both
 * outputs, so an SDK upgrade that changes the format fails the build instead
 * of drifting silently.
 */
function toolListing(entry: CatalogEntry, registered: RegisteredTool): Tool {
  if (!entry.listing) {
    const input = normalizeObjectSchema(registered.inputSchema);
    const listing: Tool = {
      name: entry.name,
      title: registered.title,
      description: registered.description,
      inputSchema: (input
        ? toJsonSchemaCompat(input, { strictUnions: true, pipeStrategy: 'input' })
        : EMPTY_OBJECT_JSON_SCHEMA) as Tool['inputSchema'],
      annotations: registered.annotations,
      execution: registered.execution,
      _meta: registered._meta,
    };
    const output = normalizeObjectSchema(registered.outputSchema);
    if (output) {
      listing.outputSchema = toJsonSchemaCompat(output, {
        strictUnions: true,
        pipeStrategy: 'output',
      }) as Tool['outputSchema'];
    }
    // Every caller receives this same object, so it must never change: a mutation
    // anywhere downstream would leak into other callers' responses. Cloned first
    // so the freeze does not reach the annotations the SDK still holds.
    entry.listing = deepFreeze(structuredClone(listing));
  }
  return entry.listing;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function buildCatalogEntry(
  tool: (typeof api.endpoints)[0],
  endpointConfig: EndpointConfig | undefined
): CatalogEntry {
  // Build parameter schema from the generated client tool definition
  const paramSchema: Record<string, z.ZodTypeAny> = {};
  for (const param of tool.parameters || []) {
    if (param.type === 'Body') {
      paramSchema[param.name] = coerceJsonStringBody(
        param.schema ? shallowBodySchema(param.schema) : z.unknown()
      ).optional();
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

  if (acceptsOutputShape(endpointConfig)) {
    paramSchema['shape'] = outputShapeParam;
  }

  if (endpointConfig?.reportPagination) {
    paramSchema['allPages'] = z
      .boolean()
      .describe(
        'Fetch every page server-side (Graph returns at most 50 rows per call) until TotalRowCount, ' +
          'starting from body.skip. Capped by MS365_ADMIN_MCP_REPORT_MAX_ROWS (default 5000); ' +
          'the response carries a pagination block saying whether it was truncated.'
      )
      .optional();
    paramSchema['dedupeBy'] = z
      .string()
      .describe(
        'With allPages: report column whose value identifies a row (e.g. DeviceName); ' +
          'later rows with the same value are dropped.'
      )
      .optional();
  }

  return {
    name: tool.alias,
    description: describeTool(
      tool.description || `Execute ${tool.method.toUpperCase()} request to ${tool.path}`,
      endpointConfig,
      tool.method
    ),
    inputShape: paramSchema,
    annotations: toolAnnotations(tool.alias, tool.method),
    requiresAppOnly: requiresAppOnly(endpointConfig?.appPermissions),
  };
}

/** Base description, then the llmTip and the risk copy, as the model reads them. */
function describeTool(
  base: string,
  config: { llmTip?: string; riskLevel?: RiskLevel } | undefined,
  method: string
): string {
  let toolDescription = base;
  if (config?.llmTip) {
    toolDescription += `\n\nTIP: ${config.llmTip}`;
  }
  if (config?.riskLevel) {
    // SEC-G03: read-operation risk copy differs from write-operation copy.
    const isWrite = method.toUpperCase() !== 'GET';
    let riskCopy = '';
    if (isWrite) {
      if (config.riskLevel === 'critical') {
        riskCopy =
          'This action is irreversible or has major security impact. Always confirm with the operator before executing.';
      } else if (config.riskLevel === 'high') {
        riskCopy =
          'This action has significant impact. Verify the target carefully before executing.';
      }
    } else {
      if (config.riskLevel === 'high') {
        riskCopy =
          'This response contains secrets or highly sensitive data (e.g. recovery keys, LAPS passwords, legal-hold material). Do not echo verbatim; confirm with the operator before sharing.';
      } else if (config.riskLevel === 'medium') {
        riskCopy =
          'This response contains PII or authentication metadata (sign-ins, MFA factors, mail metadata, risk detections). Handle with care and avoid casual disclosure.';
      }
    }
    toolDescription += `\n\nRISK LEVEL: ${config.riskLevel.toUpperCase()}. ${riskCopy}`;
  }
  return toolDescription;
}

function toolAnnotations(name: string, method: string): ToolAnnotations {
  return {
    title: name,
    readOnlyHint: method.toUpperCase() === 'GET',
    destructiveHint: ['POST', 'PATCH', 'DELETE'].includes(method.toUpperCase()),
    openWorldHint: true,
  };
}

function requiresAppOnly(appPermissions: string[] | undefined): boolean {
  return appPermissions?.some((p) => APP_ONLY_PERMISSIONS.has(p)) ?? false;
}
