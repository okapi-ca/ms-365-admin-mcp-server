import crypto from 'crypto';

export interface PkceEntry {
  clientChallenge: string;
  serverVerifier: string;
  redirectUri: string;
  // SEC-F04b: bind the PKCE entry to the DCR client_id that initiated the
  // /authorize call. /token then rejects any attempt to redeem a code under a
  // different client_id.
  clientId: string;
  expiresAt: number;
}

export interface RegisteredClient {
  clientId: string;
  clientSecretHash: string;
  redirectUris: string[];
  createdAt: number;
}

export interface OAuthStorage {
  savePkce(entry: PkceEntry): Promise<void>;
  // Atomic fetch-and-delete. Returns null if the entry is missing, expired, or
  // was consumed by a concurrent caller. One-shot semantics prevent replay.
  consumePkce(clientChallenge: string): Promise<PkceEntry | null>;
  saveClient(client: RegisteredClient): Promise<void>;
  getClient(clientId: string): Promise<RegisteredClient | null>;
}

export function hashClientSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function verifyClientSecret(plaintext: string, hash: string): boolean {
  const computed = Buffer.from(hashClientSecret(plaintext), 'utf8');
  const expected = Buffer.from(hash, 'utf8');
  if (computed.length !== expected.length) return false;
  return crypto.timingSafeEqual(computed, expected);
}
