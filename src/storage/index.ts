import logger from '../logger.js';
import { MemoryStorage } from './memory-storage.js';
import type { OAuthStorage } from './oauth-storage.js';

export type { OAuthStorage, PkceEntry, RegisteredClient } from './oauth-storage.js';
export { hashClientSecret, verifyClientSecret } from './oauth-storage.js';
export { MemoryStorage } from './memory-storage.js';

export interface StorageFactoryOptions {
  tableName?: string;
}

// Resolves an OAuthStorage from environment:
// - AZURE_STORAGE_ACCOUNT_NAME → TableStorage via DefaultAzureCredential (prod / Container Apps)
// - AZURE_STORAGE_CONNECTION_STRING → TableStorage via connection string (local dev / Azurite)
// - neither → MemoryStorage (stdio, tests, non-OAuth deployments)
export async function createOAuthStorage(
  options: StorageFactoryOptions = {}
): Promise<OAuthStorage> {
  const tableName = options.tableName ?? process.env.AZURE_STORAGE_TABLE_NAME ?? 'oauthstate';
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;

  if (accountName || connectionString) {
    const { TableStorage } = await import('./table-storage.js');
    return TableStorage.create({ accountName, connectionString, tableName });
  }

  logger.info('OAuth state backed by in-process memory (single-replica only)');
  return new MemoryStorage();
}
