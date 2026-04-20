import type { OAuthStorage, PkceEntry, RegisteredClient } from './oauth-storage.js';

const PKCE_MAX_ENTRIES = 1000;

export class MemoryStorage implements OAuthStorage {
  private pkce = new Map<string, PkceEntry>();
  private clients = new Map<string, RegisteredClient>();

  async savePkce(entry: PkceEntry): Promise<void> {
    this.prunePkce();
    this.pkce.set(entry.clientChallenge, entry);
  }

  async consumePkce(clientChallenge: string): Promise<PkceEntry | null> {
    const entry = this.pkce.get(clientChallenge);
    if (!entry) return null;
    this.pkce.delete(clientChallenge);
    if (entry.expiresAt < Date.now()) return null;
    return entry;
  }

  async saveClient(client: RegisteredClient): Promise<void> {
    this.clients.set(client.clientId, client);
  }

  async getClient(clientId: string): Promise<RegisteredClient | null> {
    return this.clients.get(clientId) ?? null;
  }

  private prunePkce(): void {
    const now = Date.now();
    if (this.pkce.size <= PKCE_MAX_ENTRIES) {
      for (const [k, v] of this.pkce) {
        if (v.expiresAt < now) this.pkce.delete(k);
      }
      return;
    }
    const entries = [...this.pkce.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (let i = 0; i < entries.length - PKCE_MAX_ENTRIES; i++) {
      this.pkce.delete(entries[i][0]);
    }
  }
}
