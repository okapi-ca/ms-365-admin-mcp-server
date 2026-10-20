import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';

/**
 * `run-hunting-query` calls failed at 60 s from the claude-device bridge. The
 * limit is the MCP client's default request timeout, not anything this server
 * sets, so the fix is guidance: the tool tip and docs/TROUBLESHOOTING.md quote
 * the 60 s figure. This suite pins that figure to the SDK constant it comes
 * from, so an SDK upgrade that moves the default fails here instead of leaving
 * the guidance quietly wrong.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const endpoints: { toolName: string; llmTip?: string }[] = JSON.parse(
  readFileSync(path.join(root, 'src', 'endpoints.json'), 'utf8')
);
const troubleshooting = readFileSync(path.join(root, 'docs', 'TROUBLESHOOTING.md'), 'utf8');

describe('run-hunting-query timeout guidance', () => {
  it('quotes the MCP SDK default request timeout', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MSEC).toBe(60_000);
    expect(troubleshooting).toContain('60,000 ms');
  });

  it('tells the model how to stay under it', () => {
    const tip = endpoints.find((e) => e.toolName === 'run-hunting-query')?.llmTip ?? '';
    expect(tip).toContain('60 s');
    expect(tip).toMatch(/Timespan/);
    expect(tip).toMatch(/\btake\b/);
  });
});
