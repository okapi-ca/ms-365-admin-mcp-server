import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * `--list-tools` printed its JSON with console.log and then called process.exit.
 * When stdout is a pipe, Node writes to it asynchronously, so the exit discarded
 * whatever was still queued: `node dist/index.js --list-tools | jq` saw the
 * first 64 KiB and a parse error. A terminal hid the bug, because TTY writes are
 * synchronous. The tool listing is well past 64 KiB, so the suite runs the real
 * entrypoint with a piped stdout and parses everything it receives.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function runCli(args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') }));
  });
}

describe('CLI listings written to a pipe', () => {
  it('--list-tools delivers the whole document', async () => {
    const { code, stdout } = await runCli(['--list-tools']);

    expect(code).toBe(0);
    // Past the 64 KiB pipe buffer, where the truncation used to cut.
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(64 * 1024);
    const listing = JSON.parse(stdout) as { count: number; tools: unknown[] };
    expect(listing.tools).toHaveLength(listing.count);
  }, 30_000);

  it('--list-permissions delivers the whole document', async () => {
    const { code, stdout } = await runCli(['--list-permissions']);

    expect(code).toBe(0);
    const listing = JSON.parse(stdout) as { permissions: string[] };
    expect(listing.permissions.length).toBeGreaterThan(0);
  }, 30_000);
});
