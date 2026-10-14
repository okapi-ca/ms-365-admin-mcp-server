/**
 * Server-side paging for the Intune reporting actions
 * (`POST /deviceManagement/reports/get*Report`).
 *
 * These actions answer a table — `Schema` (columns), `Values` (rows as arrays in
 * column order) and `TotalRowCount` — and Graph caps a page at 50 rows whatever
 * `top` the caller sends. Paging by hand means one tool call per 50 rows, so a
 * report over a fleet of a thousand devices takes twenty-odd calls. An endpoint
 * flagged `reportPagination` accepts `allPages: true` and the server walks
 * `skip` until `TotalRowCount` is reached.
 *
 * Pure module: the page fetcher is injected, so the loop is unit-tested without
 * Graph.
 */

/** Rows fetched at most when the caller sets no ceiling; env-overridable. */
export const DEFAULT_REPORT_MAX_ROWS = 5000;

export interface ReportPage {
  Schema?: { Column: string; PropertyType?: string }[];
  Values?: unknown[][];
  TotalRowCount?: number;
  [key: string]: unknown;
}

export interface ReportPaginationOptions {
  /** Column whose value identifies a row; later duplicates are dropped. */
  dedupeBy?: string;
  /** Stop once this many rows are collected. */
  maxRows: number;
}

export interface PaginatedReport extends ReportPage {
  pagination: {
    pagesFetched: number;
    rowsReturned: number;
    totalRowCount: number | null;
    /** True when maxRows stopped the walk before TotalRowCount. */
    truncated: boolean;
    duplicatesRemoved?: number;
  };
}

export function reportMaxRowsFromEnv(raw = process.env.MS365_ADMIN_MCP_REPORT_MAX_ROWS): number {
  if (raw === undefined || raw === '') return DEFAULT_REPORT_MAX_ROWS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_REPORT_MAX_ROWS;
}

/** `skip` of the caller's first page; a missing or invalid value means 0. */
export function initialSkip(body: Record<string, unknown>): number {
  const n = Number(body.skip);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Collects every page after `first`. `fetchPage(skip)` must resolve the parsed
 * page or reject on a Graph error; a failure mid-walk propagates rather than
 * returning a silently partial table.
 */
export async function collectReportPages(
  first: ReportPage,
  firstSkip: number,
  fetchPage: (skip: number) => Promise<ReportPage>,
  options: ReportPaginationOptions
): Promise<PaginatedReport> {
  const rows: unknown[][] = [...(first.Values ?? [])];
  const total = typeof first.TotalRowCount === 'number' ? first.TotalRowCount : null;
  let pagesFetched = 1;
  let skip = firstSkip + rows.length;

  // The walk ends on TotalRowCount, on an empty page (a report whose count moved
  // under us must not loop forever), or on the row ceiling.
  while (total !== null && skip < total && rows.length < options.maxRows) {
    const page = await fetchPage(skip);
    pagesFetched++;
    const values = page.Values ?? [];
    if (values.length === 0) break;
    rows.push(...values);
    skip += values.length;
  }

  const truncated =
    total !== null && rows.length >= options.maxRows && firstSkip + options.maxRows < total;
  let kept = rows.slice(0, options.maxRows);

  let duplicatesRemoved: number | undefined;
  if (options.dedupeBy) {
    const column = (first.Schema ?? []).findIndex((c) => c.Column === options.dedupeBy);
    if (column === -1) {
      throw new Error(
        `dedupeBy column '${options.dedupeBy}' is not in the report schema; ` +
          `available: ${(first.Schema ?? []).map((c) => c.Column).join(', ')}`
      );
    }
    const seen = new Set<string>();
    const unique = kept.filter((row) => {
      const key = JSON.stringify(row[column]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    duplicatesRemoved = kept.length - unique.length;
    kept = unique;
  }

  return {
    ...first,
    Values: kept,
    pagination: {
      pagesFetched,
      rowsReturned: kept.length,
      totalRowCount: total,
      truncated,
      ...(duplicatesRemoved !== undefined && { duplicatesRemoved }),
    },
  };
}
