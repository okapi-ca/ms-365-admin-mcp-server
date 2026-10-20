#!/usr/bin/env node

import 'dotenv/config';
import { parseArgs } from './cli.js';
import logger from './logger.js';
import AuthManager, { buildPermissionsFromEndpoints } from './auth.js';
import AdminGraphServer from './server.js';
import { version } from './version.js';
import { getSecrets } from './secrets.js';

/**
 * Writes a JSON document to stdout and exits once it has been handed to the OS.
 *
 * console.log followed by process.exit loses output when stdout is a pipe: pipe
 * writes are asynchronous in Node, and the exit discards what is still queued,
 * so `--list-tools | jq` received the first 64 KiB and a truncated document.
 */
async function printAndExit(document: unknown, code = 0): Promise<never> {
  await new Promise<void>((resolve) =>
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`, () => resolve())
  );
  process.exit(code);
}

async function main(): Promise<void> {
  try {
    const args = parseArgs();

    if (args.listPermissions) {
      const readOnly = args.readOnly || false;
      const permissions = buildPermissionsFromEndpoints(args.enabledTools, readOnly);
      const sorted = [...permissions].sort((a, b) => a.localeCompare(b));
      const filter = args.enabledTools ? args.enabledTools : undefined;
      await printAndExit({ mode: 'application', readOnly, filter, permissions: sorted });
    }

    if (args.listTools) {
      const readOnly = args.readOnly || false;
      const maxRiskLevel = args.maxRiskLevel ?? 'critical';
      const { readFileSync } = await import('fs');
      const { fileURLToPath } = await import('url');
      const path = await import('path');
      const { isToolAllowed } = await import('./risk-level.js');
      const { compositeEndpoints } = await import('./composite-tools.js');
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const endpoints = [
        ...(JSON.parse(readFileSync(path.join(__dirname, 'endpoints.json'), 'utf8')) as Array<{
          toolName: string;
          method: string;
          pathPattern: string;
          appPermissions?: string[];
          riskLevel?: 'low' | 'medium' | 'high' | 'critical';
        }>),
        ...compositeEndpoints,
      ];

      let enabledToolsRegex: RegExp | undefined;
      if (args.enabledTools) {
        enabledToolsRegex = new RegExp(args.enabledTools, 'i');
      }

      const tools = endpoints
        .filter((e) => !readOnly || e.method.toUpperCase() === 'GET')
        .filter((e) => isToolAllowed(e.riskLevel, e.method, maxRiskLevel))
        .filter((e) => !enabledToolsRegex || enabledToolsRegex.test(e.toolName))
        .map((e) => ({
          name: e.toolName,
          method: e.method.toUpperCase(),
          path: e.pathPattern,
          riskLevel: e.riskLevel,
          permissions: e.appPermissions || [],
        }));

      await printAndExit({ count: tools.length, maxRiskLevel, tools });
    }

    const secrets = await getSecrets();
    const authManager = await AuthManager.create(secrets);

    if (args.verifyLogin) {
      logger.info('Verifying client credentials...');
      const result = await authManager.testLogin();
      await printAndExit(result, result.success ? 0 : 1);
    }

    const server = new AdminGraphServer(authManager, args);
    await server.initialize(version);
    await server.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Startup error: ${message}`);
    console.error(message);
    process.exit(1);
  }
}

main();
