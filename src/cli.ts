import { Command } from 'commander';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCombinedPresetPattern, listPresets } from './tool-categories.js';
import { parseMaxRiskLevel, type RiskLevel } from './risk-level.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const version = packageJson.version;

const program = new Command();

program
  .name('ms-365-admin-mcp-server')
  .description('Microsoft 365 Admin MCP Server (application permissions)')
  .version(version)
  .option('-v', 'Enable verbose logging')
  .option('--verify-login', 'Verify login by testing client credentials against Graph API')
  .option('--read-only', 'Start server in read-only mode, disabling write operations (default)')
  .option('--allow-writes', 'Enable write operations (server is read-only by default)')
  .option(
    '--max-risk-level <level>',
    'Cap the risk level of registered tools (SEC-G01): low|medium|high|critical. Applies to both reads and writes. Implies --allow-writes. Default: no cap (equivalent to critical) when --allow-writes is set.'
  )
  .option(
    '--enabled-tools <pattern>',
    'Filter tools using regex pattern (e.g., "security|audit" to enable only security and audit tools)'
  )
  .option(
    '--preset <names>',
    'Use preset tool categories (comma-separated). Available: security, audit, health, reports, all'
  )
  .option('--list-presets', 'List all available presets and exit')
  .option('--list-permissions', 'List all required Graph API application permissions and exit')
  .option('--list-tools', 'List all available tools and exit')
  .option('--cloud <type>', 'Microsoft cloud environment: global (default) or china (21Vianet)')
  .option('--transport <type>', 'Transport mode: stdio (default) or http', 'stdio')
  .option('--port <number>', 'HTTP server port (only with --transport http)', '8080')
  .option('--host <address>', 'HTTP bind address (default: 127.0.0.1)', '127.0.0.1')
  .option(
    '--allowed-clients <ids>',
    'Comma-separated Entra app IDs allowed to connect via service-to-service tokens (HTTP mode)'
  )
  .option(
    '--oauth-mode',
    'Enable OAuth proxy endpoints (DCR, /authorize, /token) for human-user MCP clients (Claude Desktop/Code/Web)'
  )
  .option(
    '--public-url <url>',
    'Public base URL for OAuth metadata, e.g. https://mcp.example.com. Required with --oauth-mode (SEC-F02: no header-based fallback).'
  )
  .option(
    '--authorized-users <oids>',
    'Comma-separated Entra user object IDs (oid) allowed to authenticate via OAuth mode'
  )
  .option(
    '--allow-any-tenant-user',
    'Accept any authenticated user in the configured tenant (SEC-F01 opt-in). Required when --oauth-mode is set without --authorized-users.'
  )
  .option(
    '--required-user-scopes <scopes>',
    'Comma-separated scopes user tokens must contain in their scp claim (SEC-F03). Default: access_as_user. Empty string disables the check.'
  )
  .option(
    '--no-dynamic-registration',
    'Disable the OAuth Dynamic Client Registration endpoint (default: enabled with --oauth-mode)'
  )
  .option(
    '--log-redact-upn',
    'Replace UPN values in log lines with a SHA-256 prefix (SEC-F08 / SEC-004). Recommended for regulated tenants (PIPEDA, RGPD, Loi 25) when logs are forwarded to a SIEM. The Entra oid (non-PII GUID) stays plaintext for forensic pivots.'
  );

export interface CommandOptions {
  v?: boolean;
  verifyLogin?: boolean;
  readOnly?: boolean;
  allowWrites?: boolean;
  maxRiskLevel?: RiskLevel;
  enabledTools?: string;
  preset?: string;
  listPresets?: boolean;
  listPermissions?: boolean;
  listTools?: boolean;
  cloud?: string;
  transport?: string;
  port?: string;
  host?: string;
  allowedClients?: string;
  oauthMode?: boolean;
  publicUrl?: string;
  authorizedUsers?: string;
  allowAnyTenantUser?: boolean;
  requiredUserScopes?: string;
  dynamicRegistration?: boolean;
  logRedactUpn?: boolean;
  [key: string]: unknown;
}

export function parseArgs(): CommandOptions {
  program.parse();
  const options = program.opts();

  if (options.listPresets) {
    const presets = listPresets();
    console.log(JSON.stringify({ presets }, null, 2));
    process.exit(0);
  }

  if (options.preset) {
    const presetNames = options.preset.split(',').map((p: string) => p.trim());
    try {
      options.enabledTools = getCombinedPresetPattern(presetNames);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  // SEC-G01: parse and validate --max-risk-level. Implies --allow-writes.
  if (options.maxRiskLevel) {
    try {
      options.maxRiskLevel = parseMaxRiskLevel(String(options.maxRiskLevel));
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
    options.allowWrites = true;
  }

  // Default to read-only. --allow-writes (or --max-risk-level, or READ_ONLY=false) enables mutations.
  if (options.allowWrites) {
    options.readOnly = false;
  } else if (process.env.READ_ONLY === 'false' || process.env.READ_ONLY === '0') {
    options.readOnly = false;
  } else {
    options.readOnly = true;
  }

  if (process.env.ENABLED_TOOLS) {
    options.enabledTools = process.env.ENABLED_TOOLS;
  }

  // SEC-11: Validate regex early and limit complexity to prevent ReDoS
  if (options.enabledTools) {
    if (options.enabledTools.length > 500) {
      console.error('Error: --enabled-tools pattern too long (max 500 characters)');
      process.exit(1);
    }
    try {
      new RegExp(options.enabledTools, 'i');
    } catch {
      console.error(`Error: invalid --enabled-tools regex: ${options.enabledTools}`);
      process.exit(1);
    }
  }

  if (options.cloud) {
    process.env.MS365_ADMIN_MCP_CLOUD_TYPE = options.cloud;
  }

  return options;
}
