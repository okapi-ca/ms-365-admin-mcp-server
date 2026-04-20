import type { TableClient, TableServiceClient } from '@azure/data-tables';
import logger from '../logger.js';
import type { OAuthStorage, PkceEntry, RegisteredClient } from './oauth-storage.js';

const PKCE_PARTITION = 'pkce';
const DCR_PARTITION = 'dcr';

interface PkceEntity {
  partitionKey: string;
  rowKey: string;
  serverVerifier: string;
  redirectUri: string;
  clientId: string;
  expiresAt: number;
}

interface ClientEntity {
  partitionKey: string;
  rowKey: string;
  clientSecretHash: string;
  redirectUrisJson: string;
  createdAt: number;
}

export class TableStorage implements OAuthStorage {
  constructor(private client: TableClient) {}

  static async create(options: {
    accountName?: string;
    connectionString?: string;
    tableName: string;
  }): Promise<TableStorage> {
    const { TableClient, TableServiceClient } = await import('@azure/data-tables');
    const { DefaultAzureCredential } = await import('@azure/identity');

    let client: TableClient;
    let service: TableServiceClient;

    if (options.connectionString) {
      client = TableClient.fromConnectionString(options.connectionString, options.tableName, {
        allowInsecureConnection: options.connectionString.includes('UseDevelopmentStorage=true'),
      });
      service = TableServiceClient.fromConnectionString(options.connectionString, {
        allowInsecureConnection: options.connectionString.includes('UseDevelopmentStorage=true'),
      });
    } else if (options.accountName) {
      const credential = new DefaultAzureCredential();
      const endpoint = `https://${options.accountName}.table.core.windows.net`;
      client = new TableClient(endpoint, options.tableName, credential);
      service = new TableServiceClient(endpoint, credential);
    } else {
      throw new Error(
        'TableStorage requires either connectionString or accountName (for managed identity)'
      );
    }

    await service.createTable(options.tableName).catch((err: { statusCode?: number }) => {
      if (err.statusCode !== 409) throw err;
    });

    logger.info(`OAuth state backed by Azure Table "${options.tableName}"`);
    return new TableStorage(client);
  }

  async savePkce(entry: PkceEntry): Promise<void> {
    const entity: PkceEntity = {
      partitionKey: PKCE_PARTITION,
      rowKey: entry.clientChallenge,
      serverVerifier: entry.serverVerifier,
      redirectUri: entry.redirectUri,
      clientId: entry.clientId,
      expiresAt: entry.expiresAt,
    };
    await this.client.upsertEntity(entity, 'Replace');
  }

  async consumePkce(clientChallenge: string): Promise<PkceEntry | null> {
    let entity: PkceEntity & { etag: string };
    try {
      entity = (await this.client.getEntity<PkceEntity>(
        PKCE_PARTITION,
        clientChallenge
      )) as PkceEntity & { etag: string };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw err;
    }

    try {
      await this.client.deleteEntity(PKCE_PARTITION, clientChallenge, { etag: entity.etag });
    } catch (err) {
      // 412: another caller consumed it between get and delete. 404: already gone.
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 412 || status === 404) return null;
      throw err;
    }

    if (entity.expiresAt < Date.now()) return null;
    return {
      clientChallenge,
      serverVerifier: entity.serverVerifier,
      redirectUri: entity.redirectUri,
      clientId: entity.clientId,
      expiresAt: entity.expiresAt,
    };
  }

  async saveClient(client: RegisteredClient): Promise<void> {
    const entity: ClientEntity = {
      partitionKey: DCR_PARTITION,
      rowKey: client.clientId,
      clientSecretHash: client.clientSecretHash,
      redirectUrisJson: JSON.stringify(client.redirectUris),
      createdAt: client.createdAt,
    };
    await this.client.createEntity(entity);
  }

  async getClient(clientId: string): Promise<RegisteredClient | null> {
    try {
      const entity = await this.client.getEntity<ClientEntity>(DCR_PARTITION, clientId);
      let redirectUris: string[] = [];
      try {
        redirectUris = JSON.parse(entity.redirectUrisJson);
      } catch {
        redirectUris = [];
      }
      return {
        clientId,
        clientSecretHash: entity.clientSecretHash,
        redirectUris,
        createdAt: entity.createdAt,
      };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw err;
    }
  }
}
