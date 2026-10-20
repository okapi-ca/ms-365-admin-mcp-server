/**
 * Composite tools: tools that are not one Graph endpoint, so they cannot be an
 * entry in endpoints.json (which the generator maps 1:1 onto the OpenAPI spec).
 *
 * Each composite carries the same metadata as an endpoints.json entry —
 * toolName, README section, appPermissions, llmTip, riskLevel — and every
 * consumer of the catalog reads it from `compositeEndpoints` next to
 * endpoints.json: registration and its filters (graph-tools.ts), the tool
 * partitions, `--list-tools`, `--list-permissions` and the README inventory
 * tests. Only the handler is specific.
 *
 * `method` is the composite's effect, not the HTTP verb it sends: a read that
 * travels in POST /$batch is declared `get`, so --read-only and the write-tier
 * filters treat it as the read it is.
 */
import { z } from 'zod';
import logger from './logger.js';
import { KEPT_ODATA_ANNOTATIONS } from './graph-client.js';
import type GraphClient from './graph-client.js';

export interface CompositeEndpoint {
  toolName: string;
  /** README inventory section; tool-partitions.ts groups tools by it. */
  section: string;
  method: 'get';
  /** The Graph route(s) the tool calls, for --list-tools. */
  pathPattern: string;
  appPermissions: string[];
  llmTip: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
}

interface ToolResult {
  content: { type: 'text'; text: string; [key: string]: unknown }[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface CompositeTool extends CompositeEndpoint {
  description: string;
  /** Key of the result's row list; set, the tool accepts `shape` (output-shape.ts). */
  listKey?: string;
  inputShape: Record<string, z.ZodTypeAny>;
  run(graphClient: GraphClient, params: Record<string, unknown>): Promise<ToolResult>;
}

// ── get-managed-devices-by-names ────────────────────────────────────────────
//
// list-managed-devices cannot look up several devices by name: Graph returns an
// empty list for `deviceName eq 'A' or deviceName eq 'B'` and a 500 for
// `deviceName in ('A','B')`. An audit can have hundreds of names to resolve. One
// `deviceName eq` request per name works, and $batch carries 20 of them per call.

/** Graph's ceiling on requests per $batch call. */
export const BATCH_SIZE = 20;
export const MAX_DEVICE_NAMES = 500;
const MAX_NAME_LENGTH = 256;
/** Rounds of retry for sub-requests Graph throttled (429) or could not serve. */
const MAX_RETRY_ROUNDS = 2;
// Kept short: the MCP client abandons a call after 60 s (docs/TROUBLESHOOTING.md).
const MAX_RETRY_DELAY_MS = 10_000;
const RETRYABLE = new Set([429, 503, 504]);

/** OData string literal: a single quote is escaped by doubling it. */
export function deviceNameFilter(name: string): string {
  return `deviceName eq '${name.replace(/'/g, "''")}'`;
}

/** Trims, drops blanks and keeps the first spelling of each name (case-insensitive). */
export function normaliseDeviceNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (name === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Some MCP clients send an array argument as a string. Accept a JSON array, or
 * a list separated by commas or newlines — device names contain neither.
 */
const deviceNamesSchema = z.preprocess(
  (val) => {
    if (typeof val !== 'string') return val;
    const trimmed = val.trim();
    if (trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return val;
      }
    }
    return trimmed.split(/[,\n]/);
  },
  z.array(z.string().max(MAX_NAME_LENGTH)).min(1).max(MAX_DEVICE_NAMES)
);

interface BatchResponse {
  id: string;
  status: number;
  headers?: Record<string, string>;
  body?: {
    value?: Record<string, unknown>[];
    error?: { code?: string; message?: string };
  } & Record<string, unknown>;
}

export interface DevicesByNamesResult {
  requested: number;
  found: number;
  devices: Record<string, unknown>[];
  notFound: string[];
  /** Names that matched more than one managed device, with the match count. */
  multipleMatches: Record<string, number>;
  errors: { deviceName: string; status: number; error: string }[];
  batches: number;
}

/** Same annotations as GraphClient keeps on list-managed-devices: @odata.type survives. */
function stripODataAnnotations(device: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(device).filter(
      ([k]) => !k.startsWith('@odata.') || KEPT_ODATA_ANNOTATIONS.has(k)
    )
  );
}

function retryAfterMs(response: BatchResponse): number {
  const header = Object.entries(response.headers ?? {}).find(
    ([k]) => k.toLowerCase() === 'retry-after'
  )?.[1];
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_RETRY_DELAY_MS)
    : 1000;
}

function subRequestUrl(name: string, select: string | undefined): string {
  const query = [`$filter=${encodeURIComponent(deviceNameFilter(name))}`];
  if (select) query.push(`$select=${encodeURIComponent(select)}`);
  return `/deviceManagement/managedDevices?${query.join('&')}`;
}

/**
 * `$select` without deviceName would return devices the caller cannot map back
 * to the names they asked for.
 */
export function withDeviceName(select: string | undefined): string | undefined {
  if (select === undefined || select.trim() === '') return undefined;
  const fields = select
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '');
  return fields.some((f) => f.toLowerCase() === 'devicename')
    ? fields.join(',')
    : ['deviceName', ...fields].join(',');
}

async function sendBatch(
  graphClient: GraphClient,
  names: string[],
  select: string | undefined
): Promise<BatchResponse[]> {
  const requests = names.map((name, i) => ({
    id: String(i),
    method: 'GET',
    url: subRequestUrl(name, select),
  }));
  const result = await graphClient.graphRequest('/$batch', {
    method: 'POST',
    body: JSON.stringify({ requests }),
    rawResponse: true,
  });
  const text = result.content?.[0]?.text ?? '';
  // The whole batch failed (auth, permission, outage): every name would fail
  // the same way, so the call fails rather than reporting N identical errors.
  if (result.isError) throw new Error(text);
  return (JSON.parse(text) as { responses?: BatchResponse[] }).responses ?? [];
}

export async function getManagedDevicesByNames(
  graphClient: GraphClient,
  deviceNames: string[],
  select: string | undefined,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<DevicesByNamesResult> {
  const names = normaliseDeviceNames(deviceNames);
  const projection = withDeviceName(select);
  const matches = new Map<string, Record<string, unknown>[]>();
  const errors: DevicesByNamesResult['errors'] = [];
  let batches = 0;

  let pending = names;
  for (let round = 0; pending.length > 0; round++) {
    const retry: string[] = [];
    let delay = 0;

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const chunk = pending.slice(i, i + BATCH_SIZE);
      const responses = await sendBatch(graphClient, chunk, projection);
      batches++;

      const byId = new Map(responses.map((r) => [r.id, r]));
      chunk.forEach((name, j) => {
        const response = byId.get(String(j));
        if (!response) {
          errors.push({ deviceName: name, status: 0, error: 'No response in $batch result' });
          return;
        }
        if (response.status >= 200 && response.status < 300) {
          matches.set(name, (response.body?.value ?? []).map(stripODataAnnotations));
          return;
        }
        if (RETRYABLE.has(response.status) && round < MAX_RETRY_ROUNDS) {
          retry.push(name);
          delay = Math.max(delay, retryAfterMs(response));
          return;
        }
        const err = response.body?.error;
        errors.push({
          deviceName: name,
          status: response.status,
          error: [err?.code, err?.message].filter(Boolean).join(': ') || 'Request failed',
        });
      });
    }

    if (retry.length > 0) {
      logger.warn(`$batch throttled ${retry.length} device lookup(s); retrying in ${delay} ms`);
      await sleep(delay);
    }
    pending = retry;
  }

  const devices: Record<string, unknown>[] = [];
  const seenIds = new Set<unknown>();
  const notFound: string[] = [];
  const multipleMatches: Record<string, number> = {};
  for (const name of names) {
    const found = matches.get(name);
    if (found === undefined) continue; // reported in errors
    if (found.length === 0) notFound.push(name);
    if (found.length > 1) multipleMatches[name] = found.length;
    for (const device of found) {
      if (device.id !== undefined && seenIds.has(device.id)) continue;
      seenIds.add(device.id);
      devices.push(device);
    }
  }

  return {
    requested: names.length,
    found: names.length - notFound.length - errors.length,
    devices,
    notFound,
    multipleMatches,
    errors,
    batches,
  };
}

const getManagedDevicesByNamesTool: CompositeTool = {
  toolName: 'get-managed-devices-by-names',
  section: 'Managed devices',
  method: 'get',
  pathPattern: '/$batch → /deviceManagement/managedDevices?$filter=deviceName eq',
  appPermissions: ['DeviceManagementManagedDevices.Read.All'],
  llmTip:
    'Resolves a list of device names to Intune managed devices in one call. Use it instead of ' +
    'list-managed-devices with an OR / in() filter on deviceName, which Graph answers with an empty ' +
    `list or a 500. Up to ${MAX_DEVICE_NAMES} names; matching is case-insensitive and exact (no prefix). ` +
    'Pass select (e.g. deviceName,isEncrypted,complianceState,osVersion,lastSyncDateTime,userPrincipalName) ' +
    'to keep the response small. The result lists devices, notFound names, names matching several ' +
    'devices (multipleMatches) and per-name errors.',
  description:
    'Look up several Intune managed devices by exact device name. Sends one ' +
    "`$filter=deviceName eq '<name>'` request per name through Graph $batch (20 per call) " +
    'and merges the results.',
  listKey: 'devices',
  inputShape: {
    deviceNames: deviceNamesSchema.describe(
      `Device names to resolve (1-${MAX_DEVICE_NAMES}). Duplicates and blanks are ignored.`
    ),
    select: z
      .string()
      .describe('Comma-separated managedDevice fields to return; deviceName is always included')
      .optional(),
  },
  async run(graphClient, params) {
    const result = await getManagedDevicesByNames(
      graphClient,
      params.deviceNames as string[],
      typeof params.select === 'string' ? params.select : undefined
    );
    logger.info(
      `get-managed-devices-by-names: ${result.requested} name(s), ${result.found} found, ` +
        `${result.errors.length} error(s), ${result.batches} batch call(s)`
    );
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
};

export const compositeTools: readonly CompositeTool[] = [getManagedDevicesByNamesTool];

/** The composites' catalog metadata, shaped like endpoints.json entries. */
export const compositeEndpoints: readonly CompositeEndpoint[] = compositeTools.map(
  ({ toolName, section, method, pathPattern, appPermissions, llmTip, riskLevel }) => ({
    toolName,
    section,
    method,
    pathPattern,
    appPermissions,
    llmTip,
    ...(riskLevel !== undefined && { riskLevel }),
  })
);
