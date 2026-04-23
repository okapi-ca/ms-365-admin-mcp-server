#!/usr/bin/env node

// ms-365-admin-mcp-auth — RFC 8628 device_code bootstrap helper.
//
// Pre-seeds `mcp-remote`'s token cache (~/.mcp-auth/mcp-remote-<version>/)
// using Entra ID's device authorization flow. Once the cache exists,
// Claude Desktop / Claude Code launches mcp-remote normally and it finds
// valid tokens without ever opening a browser.
//
// Use cases this solves:
//  - macOS Platform SSO intercepts WebKit/Safari OAuth flows
//  - Headless Docker containers with no browser
//  - Remote SSH dev envs / devcontainers / Codespaces
//  - Any admin account that wants MFA on a trusted device (phone)
//    instead of on the host running the MCP client.
//
// The helper registers a fresh DCR client per run (so each bootstrap
// yields its own client_id + client_secret — no long-lived secret
// shared between machines).

import 'dotenv/config';
import { Command } from 'commander';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_MCP_REMOTE_VERSION = '0.1.38';
const USER_AGENT = 'ms-365-admin-mcp-auth';

// Exit codes — documented so Docker/CI wrappers can react.
const EXIT = {
  OK: 0,
  USAGE: 1,
  NETWORK: 2,
  DENIED: 3,
  TIMEOUT: 4,
} as const;

interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  device_authorization_endpoint?: string;
  grant_types_supported?: string[];
  scopes_supported?: string[];
}

interface DcrResponse {
  client_id: string;
  client_secret: string;
  client_secret_expires_at?: number;
  client_id_issued_at?: number;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method: string;
  scope?: string;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
  message?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

interface OAuthError {
  error: string;
  error_description?: string;
}

function die(code: number, message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

// Normalize a user-supplied server URL so we can derive the issuer base
// regardless of whether they pasted "...azurecontainerapps.io/mcp" or the
// bare host. mcp-remote hashes the URL _with_ /mcp, so we preserve that
// exact form for the cache key.
function normalizeServer(raw: string): { base: string; mcpUrl: string } {
  const trimmed = stripTrailingSlash(raw.trim());
  const mcpUrl = trimmed.endsWith('/mcp') ? trimmed : `${trimmed}/mcp`;
  const base = stripTrailingSlash(mcpUrl.slice(0, -'/mcp'.length));
  return { base, mcpUrl };
}

// mcp-remote's cache key formula (dist/chunk-65X3S4HB.js — getServerUrlHash):
//   md5(serverUrl [+ '|' + authorizeResource] [+ '|' + sortedHeaders])
// We pass only the serverUrl, matching the default Claude Desktop config.
function serverUrlHash(mcpUrl: string): string {
  return crypto.createHash('md5').update(mcpUrl).digest('hex');
}

async function fetchJson<T>(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<{ status: number; body: T | OAuthError }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...init.headers,
      },
      body: init.body,
    });
  } catch (error) {
    die(EXIT.NETWORK, `network error calling ${url}: ${(error as Error).message}`);
  }
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as T | OAuthError };
  } catch {
    if (response.status >= 400) {
      die(EXIT.NETWORK, `${url} returned HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    die(EXIT.NETWORK, `${url} returned non-JSON body: ${text.slice(0, 200)}`);
  }
}

async function discoverMetadata(base: string): Promise<AuthServerMetadata> {
  const url = `${base}/.well-known/oauth-authorization-server`;
  const { status, body } = await fetchJson<AuthServerMetadata>(url);
  if (status !== 200) {
    die(EXIT.NETWORK, `metadata endpoint ${url} returned HTTP ${status}`);
  }
  const meta = body as AuthServerMetadata;
  if (!meta.device_authorization_endpoint) {
    die(
      EXIT.USAGE,
      `server at ${base} does not advertise device_authorization_endpoint. ` +
        `Upgrade the server to a version that supports RFC 8628 device_code flow.`
    );
  }
  if (meta.grant_types_supported && !meta.grant_types_supported.includes(DEVICE_CODE_GRANT)) {
    die(
      EXIT.USAGE,
      `server at ${base} does not list "${DEVICE_CODE_GRANT}" in grant_types_supported`
    );
  }
  return meta;
}

async function registerClient(
  meta: AuthServerMetadata,
  base: string
): Promise<{ clientId: string; clientSecret: string; raw: DcrResponse }> {
  const url = meta.registration_endpoint ?? `${base}/register`;
  const { status, body } = await fetchJson<DcrResponse>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Empty redirect_uris: the device_code flow doesn't use a redirect, but
      // RFC 7591 doesn't require one either.
      redirect_uris: [],
      grant_types: ['authorization_code', 'refresh_token', DEVICE_CODE_GRANT],
      token_endpoint_auth_method: 'client_secret_post',
      client_name: 'ms-365-admin-mcp-auth bootstrap',
    }),
  });
  if (status !== 201) {
    const err = body as OAuthError;
    die(
      EXIT.NETWORK,
      `/register returned HTTP ${status}: ${err.error ?? 'unknown'} — ${err.error_description ?? ''}`
    );
  }
  const dcr = body as DcrResponse;
  if (!dcr.client_id || !dcr.client_secret) {
    die(EXIT.NETWORK, `/register did not return a confidential client (client_id + client_secret)`);
  }
  return { clientId: dcr.client_id, clientSecret: dcr.client_secret, raw: dcr };
}

async function startDeviceCode(
  meta: AuthServerMetadata,
  clientId: string,
  clientSecret: string,
  scope?: string
): Promise<DeviceCodeResponse> {
  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (scope) form.set('scope', scope);

  const { status, body } = await fetchJson<DeviceCodeResponse>(
    meta.device_authorization_endpoint!,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }
  );
  if (status !== 200) {
    const err = body as OAuthError;
    die(
      EXIT.NETWORK,
      `/devicecode returned HTTP ${status}: ${err.error ?? 'unknown'} — ${err.error_description ?? ''}`
    );
  }
  return body as DeviceCodeResponse;
}

function copyToClipboard(text: string): boolean {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === 'darwin') {
    cmd = 'pbcopy';
    args = [];
  } else if (platform === 'win32') {
    cmd = 'clip';
    args = [];
  } else {
    // Try wl-copy (Wayland) then xclip (X11). Best effort — users on
    // headless servers won't have either, which is fine.
    cmd = process.env.WAYLAND_DISPLAY ? 'wl-copy' : 'xclip';
    args = cmd === 'xclip' ? ['-selection', 'clipboard'] : [];
  }
  try {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(text);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForToken(
  meta: AuthServerMetadata,
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  initialInterval: number,
  expiresInSec: number
): Promise<TokenResponse> {
  let interval = Math.max(initialInterval, 1) * 1000;
  const deadline = Date.now() + expiresInSec * 1000;

  // Poll the token endpoint in a loop. RFC 8628 §3.5 defines the only
  // four error cases we must distinguish: authorization_pending (keep
  // polling), slow_down (bump interval +5s), expired_token and
  // access_denied (fatal).
  while (Date.now() < deadline) {
    await sleep(interval);

    const form = new URLSearchParams({
      grant_type: DEVICE_CODE_GRANT,
      device_code: deviceCode,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const { status, body } = await fetchJson<TokenResponse>(meta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    if (status === 200) {
      const tokens = body as TokenResponse;
      if (!tokens.access_token) {
        die(EXIT.NETWORK, `/token returned 200 but no access_token`);
      }
      return tokens;
    }

    const err = body as OAuthError;
    // RFC 8628 §3.5 distinguishes four error codes. authorization_pending and
    // slow_down are transient (keep polling); expired_token and access_denied
    // are fatal. Anything else is an unexpected server/upstream error.
    if (err.error === 'authorization_pending') {
      // Keep current interval — user hasn't finished yet.
      continue;
    }
    if (err.error === 'slow_down') {
      // RFC 8628 §3.5: add at least 5 s to the current interval.
      interval += 5_000;
      continue;
    }
    if (err.error === 'expired_token') {
      die(EXIT.DENIED, 'device code expired before the user completed authentication');
    }
    if (err.error === 'access_denied') {
      die(EXIT.DENIED, 'user denied the device code authorization');
    }
    die(
      EXIT.NETWORK,
      `/token returned HTTP ${status}: ${err.error ?? 'unknown'} — ${err.error_description ?? ''}`
    );
  }
  die(EXIT.TIMEOUT, 'timed out waiting for user to authenticate');
}

function resolveCacheDir(override: string | undefined, mcpRemoteVersion: string): string {
  if (override) return override;
  const base = process.env.MCP_REMOTE_CONFIG_DIR ?? path.join(os.homedir(), '.mcp-auth');
  return path.join(base, `mcp-remote-${mcpRemoteVersion}`);
}

async function writeCache(
  cacheDir: string,
  hash: string,
  clientInfo: DcrResponse,
  tokens: TokenResponse
): Promise<{ clientInfoPath: string; tokensPath: string }> {
  // Mode 0700 on the directory and 0600 on the files — these tokens grant
  // access to the user's admin session, so they must be user-readable only.
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const clientInfoPath = path.join(cacheDir, `${hash}_client_info.json`);
  const tokensPath = path.join(cacheDir, `${hash}_tokens.json`);
  await fs.writeFile(clientInfoPath, JSON.stringify(clientInfo, null, 2) + '\n', { mode: 0o600 });
  await fs.writeFile(tokensPath, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
  return { clientInfoPath, tokensPath };
}

function printStart(code: DeviceCodeResponse, timeoutMinutes: number, clipboardOk: boolean): void {
  const line = '─'.repeat(64);
  process.stderr.write(
    `\n${line}\n` +
      ` Microsoft 365 Admin MCP — device code authentication\n` +
      `${line}\n` +
      ` 1. Open ${code.verification_uri}\n` +
      ` 2. Enter code: ${code.user_code}` +
      (clipboardOk ? '   (copied to clipboard)\n' : '\n') +
      ` Waiting for authentication… (timeout ${timeoutMinutes} min)\n` +
      `${line}\n\n`
  );
  if (code.verification_uri_complete && code.verification_uri_complete !== code.verification_uri) {
    process.stderr.write(` Direct link (code pre-filled): ${code.verification_uri_complete}\n\n`);
  }
}

function detectPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('ms-365-admin-mcp-auth')
    .description(
      'RFC 8628 device_code bootstrap for the MS 365 Admin MCP server. ' +
        'Pre-seeds mcp-remote token cache so Claude Desktop/Code skips the browser flow.'
    )
    .version(detectPackageVersion())
    .requiredOption(
      '-s, --server <url>',
      'MCP server URL (with or without /mcp suffix), e.g. https://your-host.azurecontainerapps.io/mcp'
    )
    .option('--scope <scope>', 'Override OAuth scope (defaults to server metadata)')
    .option(
      '--cache-dir <path>',
      'Override the cache directory. Default: $MCP_REMOTE_CONFIG_DIR/mcp-remote-<ver> ' +
        'or ~/.mcp-auth/mcp-remote-<ver>'
    )
    .option(
      '--mcp-remote-version <version>',
      'mcp-remote version used in the cache directory name',
      DEFAULT_MCP_REMOTE_VERSION
    )
    .option('--non-interactive', 'Do not copy the user_code to the clipboard')
    .option(
      '--timeout <seconds>',
      'Maximum wait time (default: 900, i.e. Entra device code TTL)',
      '900'
    );

  program.parse();
  const opts = program.opts<{
    server: string;
    scope?: string;
    cacheDir?: string;
    mcpRemoteVersion: string;
    nonInteractive?: boolean;
    timeout: string;
  }>();

  const timeoutSec = Number.parseInt(opts.timeout, 10);
  if (!Number.isFinite(timeoutSec) || timeoutSec < 30 || timeoutSec > 3600) {
    die(EXIT.USAGE, `--timeout must be an integer between 30 and 3600 seconds`);
  }

  const { base, mcpUrl } = normalizeServer(opts.server);
  const hash = serverUrlHash(mcpUrl);

  process.stderr.write(`Discovering OAuth metadata at ${base}…\n`);
  const meta = await discoverMetadata(base);

  process.stderr.write(`Registering a fresh DCR client…\n`);
  const { clientId, clientSecret, raw: clientInfo } = await registerClient(meta, base);

  process.stderr.write(`Requesting a device code (scope: ${opts.scope ?? 'server default'})…\n`);
  const deviceCode = await startDeviceCode(meta, clientId, clientSecret, opts.scope);

  const interactive = !opts.nonInteractive && process.stderr.isTTY && !process.env.CI;
  const clipboardOk = interactive ? copyToClipboard(deviceCode.user_code) : false;
  const maxWait = Math.min(deviceCode.expires_in, timeoutSec);
  printStart(deviceCode, Math.round(maxWait / 60), clipboardOk);

  const tokens = await pollForToken(
    meta,
    clientId,
    clientSecret,
    deviceCode.device_code,
    deviceCode.interval,
    maxWait
  );

  const cacheDir = resolveCacheDir(opts.cacheDir, opts.mcpRemoteVersion);
  const { clientInfoPath, tokensPath } = await writeCache(cacheDir, hash, clientInfo, tokens);

  process.stderr.write(
    `\nAuthentication complete.\n` +
      `  cache dir:   ${cacheDir}\n` +
      `  client info: ${clientInfoPath}\n` +
      `  tokens:      ${tokensPath}\n\n` +
      `Restart Claude Desktop / Claude Code — mcp-remote will reuse these tokens.\n`
  );
  process.exit(EXIT.OK);
}

main().catch((error: unknown) => {
  die(EXIT.NETWORK, `unexpected error: ${(error as Error).message}`);
});
