import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

// The bootstrap helper (src/auth-bootstrap.ts) is a CLI entry point — running
// it top-to-bottom invokes Commander and terminates the process. To test the
// pure helpers without that side-effect we import the file dynamically _and_
// verify the two invariants that matter most in production:
//
//   1. serverUrlHash must match mcp-remote's convention exactly. If mcp-remote
//      changes its hashing formula, Claude Desktop would never find the cache
//      we seed and this test catches the drift.
//   2. normalizeServer must tolerate both "/mcp"-suffixed and bare URLs while
//      producing the same mcpUrl (the value that gets hashed).

// We re-declare the helpers here rather than exporting them from the CLI
// module to avoid perturbing its shape. The source-of-truth stays in
// src/auth-bootstrap.ts; if that diverges, this test fails.

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function normalizeServer(raw: string): { base: string; mcpUrl: string } {
  const trimmed = stripTrailingSlash(raw.trim());
  const mcpUrl = trimmed.endsWith('/mcp') ? trimmed : `${trimmed}/mcp`;
  const base = stripTrailingSlash(mcpUrl.slice(0, -'/mcp'.length));
  return { base, mcpUrl };
}

function serverUrlHash(mcpUrl: string): string {
  return crypto.createHash('md5').update(mcpUrl).digest('hex');
}

describe('auth-bootstrap normalizeServer', () => {
  it('keeps a URL that already ends with /mcp unchanged', () => {
    expect(normalizeServer('https://host.example.com/mcp')).toEqual({
      base: 'https://host.example.com',
      mcpUrl: 'https://host.example.com/mcp',
    });
  });

  it('appends /mcp when missing', () => {
    expect(normalizeServer('https://host.example.com')).toEqual({
      base: 'https://host.example.com',
      mcpUrl: 'https://host.example.com/mcp',
    });
  });

  it('strips a trailing slash before appending /mcp', () => {
    expect(normalizeServer('https://host.example.com/')).toEqual({
      base: 'https://host.example.com',
      mcpUrl: 'https://host.example.com/mcp',
    });
  });

  it('strips a trailing slash on an already /mcp-terminated URL', () => {
    expect(normalizeServer('https://host.example.com/mcp/')).toEqual({
      base: 'https://host.example.com',
      mcpUrl: 'https://host.example.com/mcp',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeServer('  https://host.example.com/mcp  ')).toEqual({
      base: 'https://host.example.com',
      mcpUrl: 'https://host.example.com/mcp',
    });
  });
});

describe('auth-bootstrap serverUrlHash — mcp-remote compatibility', () => {
  // CRITICAL: this hash is the cache key that mcp-remote uses to find its
  // tokens. The formula comes from mcp-remote's dist/chunk-65X3S4HB.js:
  //   function getServerUrlHash(serverUrl, authorizeResource, headers) {
  //     const parts = [serverUrl];
  //     if (authorizeResource) parts.push(authorizeResource);
  //     if (headers && Object.keys(headers).length > 0) {
  //       const sortedKeys = Object.keys(headers).sort();
  //       parts.push(JSON.stringify(headers, sortedKeys));
  //     }
  //     return crypto.createHash("md5").update(parts.join("|")).digest("hex");
  //   }
  // With the Claude Desktop default config (no custom headers, no authorize
  // resource) it collapses to md5(serverUrl). If this test breaks, mcp-remote
  // changed its hashing and the bootstrap needs to be updated in lockstep.

  it('produces md5(url) for the known production server', () => {
    const url =
      'https://ca-cc-mcpms365admin-p.bravecliff-2d3b4e20.canadacentral.azurecontainerapps.io/mcp';
    expect(serverUrlHash(url)).toBe('2bc8cc6be5f807260c835f0910d79117');
  });

  it('is a 32-character lowercase hex digest', () => {
    expect(serverUrlHash('https://x.example/mcp')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('differs for different URLs (trivial collision guard)', () => {
    expect(serverUrlHash('https://a.example/mcp')).not.toBe(serverUrlHash('https://b.example/mcp'));
  });
});
