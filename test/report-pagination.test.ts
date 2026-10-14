import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  collectReportPages,
  DEFAULT_REPORT_MAX_ROWS,
  initialSkip,
  reportMaxRowsFromEnv,
  type ReportPage,
} from '../src/report-pagination.js';
import { registerGraphTools } from '../src/graph-tools.js';
import type GraphClient from '../src/graph-client.js';

// Node 18 lacks the File global referenced by generated Zod schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!globalThis.File) (globalThis as any).File = Blob;

const SCHEMA = [{ Column: 'DeviceName' }, { Column: 'PolicyStatus' }];

/** A report of `total` rows served 50 at a time, like Graph's Intune reports. */
function fakeReport(total: number, rowAt: (i: number) => unknown[] = (i) => [`PC-${i}`, 2]) {
  const fetched: number[] = [];
  const page = (skip: number): ReportPage => {
    fetched.push(skip);
    const values: unknown[][] = [];
    for (let i = skip; i < Math.min(skip + 50, total); i++) values.push(rowAt(i));
    return { Schema: SCHEMA, Values: values, TotalRowCount: total };
  };
  return { page, fetched };
}

describe('collectReportPages', () => {
  it('walks skip until TotalRowCount', async () => {
    const report = fakeReport(1159);
    const merged = await collectReportPages(report.page(0), 0, async (s) => report.page(s), {
      maxRows: 5000,
    });

    expect(merged.Values).toHaveLength(1159);
    expect(merged.Values?.[1158]).toEqual(['PC-1158', 2]);
    expect(merged.pagination).toEqual({
      pagesFetched: 24,
      rowsReturned: 1159,
      totalRowCount: 1159,
      truncated: false,
    });
    expect(report.fetched.slice(0, 3)).toEqual([0, 50, 100]);
  });

  it('makes no extra call when the first page holds every row', async () => {
    const report = fakeReport(12);
    const merged = await collectReportPages(report.page(0), 0, async (s) => report.page(s), {
      maxRows: 5000,
    });
    expect(merged.pagination.pagesFetched).toBe(1);
    expect(report.fetched).toEqual([0]);
  });

  it('starts from the caller skip', async () => {
    const report = fakeReport(120);
    const merged = await collectReportPages(report.page(100), 100, async (s) => report.page(s), {
      maxRows: 5000,
    });
    expect(merged.Values).toHaveLength(20);
    expect(report.fetched).toEqual([100]);
  });

  it('stops at maxRows and says so', async () => {
    const report = fakeReport(1159);
    const merged = await collectReportPages(report.page(0), 0, async (s) => report.page(s), {
      maxRows: 120,
    });
    expect(merged.Values).toHaveLength(120);
    expect(merged.pagination.truncated).toBe(true);
    expect(merged.pagination.pagesFetched).toBe(3);
  });

  it('stops on an empty page instead of looping when the count moves', async () => {
    let calls = 0;
    const first: ReportPage = { Schema: SCHEMA, Values: [['A', 2]], TotalRowCount: 500 };
    const merged = await collectReportPages(
      first,
      0,
      async () => {
        calls++;
        return { Schema: SCHEMA, Values: [], TotalRowCount: 500 };
      },
      { maxRows: 5000 }
    );
    expect(calls).toBe(1);
    expect(merged.Values).toHaveLength(1);
  });

  it('drops later duplicates of the dedupe column', async () => {
    const report = fakeReport(100, (i) => [`PC-${i % 30}`, i]);
    const merged = await collectReportPages(report.page(0), 0, async (s) => report.page(s), {
      maxRows: 5000,
      dedupeBy: 'DeviceName',
    });
    expect(merged.Values).toHaveLength(30);
    expect(merged.Values?.[0]).toEqual(['PC-0', 0]);
    expect(merged.pagination.duplicatesRemoved).toBe(70);
  });

  it('rejects a dedupe column absent from the schema', async () => {
    const report = fakeReport(10);
    await expect(
      collectReportPages(report.page(0), 0, async (s) => report.page(s), {
        maxRows: 5000,
        dedupeBy: 'SerialNumber',
      })
    ).rejects.toThrow(/SerialNumber.*DeviceName, PolicyStatus/);
  });

  it('propagates a failed page rather than returning a partial table', async () => {
    const report = fakeReport(200);
    await expect(
      collectReportPages(
        report.page(0),
        0,
        async () => {
          throw new Error('429 Too Many Requests');
        },
        { maxRows: 5000 }
      )
    ).rejects.toThrow('429');
  });
});

describe('pagination settings', () => {
  it('reads the row ceiling from the environment, falling back on bad values', () => {
    expect(reportMaxRowsFromEnv(undefined)).toBe(DEFAULT_REPORT_MAX_ROWS);
    expect(reportMaxRowsFromEnv('250')).toBe(250);
    expect(reportMaxRowsFromEnv('0')).toBe(DEFAULT_REPORT_MAX_ROWS);
    expect(reportMaxRowsFromEnv('abc')).toBe(DEFAULT_REPORT_MAX_ROWS);
  });

  it('treats a missing or invalid skip as 0', () => {
    expect(initialSkip({})).toBe(0);
    expect(initialSkip({ skip: 50 })).toBe(50);
    expect(initialSkip({ skip: -1 })).toBe(0);
  });
});

describe('allPages on a report tool', () => {
  type Handler = (params: Record<string, unknown>) => Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;

  function harness() {
    const report = fakeReport(130);
    const bodies: Record<string, unknown>[] = [];
    const handlers = new Map<string, Handler>();
    const graphClient = {
      graphRequest: async (_endpoint: string, options: { body?: string } = {}) => {
        const body = JSON.parse(options.body ?? '{}') as Record<string, unknown>;
        bodies.push(body);
        return {
          content: [{ type: 'text', text: JSON.stringify(report.page(initialSkip(body))) }],
        };
      },
    } as unknown as GraphClient;
    const server = {
      tool: (alias: string, _d: unknown, _s: unknown, _m: unknown, handler: Handler) => {
        handlers.set(alias, handler);
      },
      server: { setRequestHandler: () => {} },
    } as unknown as McpServer;
    registerGraphTools(server, graphClient, false, 'get-configuration-policy-device-status');
    return { handler: handlers.get('get-configuration-policy-device-status')!, bodies };
  }

  const body = { filter: "(PolicyId eq 'p1')", select: ['DeviceName', 'PolicyStatus'], top: 50 };

  it('returns every row inside the untrusted envelope, without leaking its own params to Graph', async () => {
    const { handler, bodies } = harness();
    const result = await handler({ body, allPages: true, dedupeBy: 'DeviceName' });

    expect(result.isError).toBeFalsy();
    const text = result.content.map((c) => c.text).join('\n');
    expect(text).toContain('trust="untrusted"');
    expect(text).toContain('"rowsReturned":130');
    expect(bodies.map((b) => b.skip)).toEqual([undefined, 50, 100]);
    for (const sent of bodies) {
      expect(sent).not.toHaveProperty('allPages');
      expect(sent).not.toHaveProperty('dedupeBy');
    }
  });

  it('keeps the single-call behaviour without allPages', async () => {
    const { handler, bodies } = harness();
    const result = await handler({ body });
    expect(bodies).toHaveLength(1);
    expect(result.content.map((c) => c.text).join('\n')).not.toContain('pagination');
  });
});
