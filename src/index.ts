#!/usr/bin/env node

import 'dotenv/config';
import { parseArgs } from './cli.js';
import logger from './logger.js';
import AuthManager, { buildPermissionsFromEndpoints } from './auth.js';
import AdminGraphServer from './server.js';
import { version } from './version.js';
import { getSecrets } from './secrets.js';

async function main(): Promise<void> {
  try {
    const args = parseArgs();

    if (args.listPermissions) {
      const readOnly = args.readOnly || false;
      const permissions = buildPermissionsFromEndpoints(args.enabledTools, readOnly);
      const sorted = [...permissions].sort((a, b) => a.localeCompare(b));
      const filter = args.enabledTools ? args.enabledTools : undefined;
      console.log(
        JSON.stringify({ mode: 'application', readOnly, filter, permissions: sorted }, null, 2)
      );
      process.exit(0);
    }

    if (args.listTools) {
      const readOnly = args.readOnly || false;
      const { readFileSync } = await import('fs');
      const { fileURLToPath } = await import('url');
      const path = await import('path');
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const endpoints = JSON.parse(
        readFileSync(path.join(__dirname, 'endpoints.json'), 'utf8')
      ) as Array<{
        toolName: string;
        method: string;
        pathPattern: string;
        appPermissions?: string[];
      }>;

      let enabledToolsRegex: RegExp | undefined;
      if (args.enabledTools) {
        enabledToolsRegex = new RegExp(args.enabledTools, 'i');
      }

      const tools = endpoints
        .filter((e) => !readOnly || e.method.toUpperCase() === 'GET')
        .filter((e) => !enabledToolsRegex || enabledToolsRegex.test(e.toolName))
        .map((e) => ({
          name: e.toolName,
          method: e.method.toUpperCase(),
          path: e.pathPattern,
          permissions: e.appPermissions || [],
        }));

      console.log(JSON.stringify({ count: tools.length, tools }, null, 2));
      process.exit(0);
    }

    const secrets = await getSecrets();
    const authManager = await AuthManager.create(secrets);

    if (args.verifyLogin) {
      logger.info('Verifying client credentials...');
      const result = await authManager.testLogin();
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
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
