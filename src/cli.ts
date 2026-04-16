import { Command } from 'commander';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCombinedPresetPattern, listPresets } from './tool-categories.js';

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
  .option(
    '--allowed-clients <ids>',
    'Comma-separated Entra app IDs allowed to connect (HTTP mode)'
  );

export interface CommandOptions {
  v?: boolean;
  verifyLogin?: boolean;
  readOnly?: boolean;
  allowWrites?: boolean;
  enabledTools?: string;
  preset?: string;
  listPresets?: boolean;
  listPermissions?: boolean;
  listTools?: boolean;
  cloud?: string;
  transport?: string;
  port?: string;
  allowedClients?: string;
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

  // Default to read-only. Only --allow-writes (or READ_ONLY=false) enables mutations.
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

  // Validate regex early so invalid patterns fail at startup, not silently
  if (options.enabledTools) {
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
