import crypto from 'crypto';

export interface PkceEntry {
  clientChallenge: string;
  serverVerifier: string;
  redirectUri: string;
  // SEC-F04b: bind the PKCE entry to the DCR client_id that initiated the
  // /authorize call. /token then rejects any attempt to redeem a code under a
  // different client_id.
  clientId: string;
  // SEC-F04d (SEC-007): the client-supplied 'state' parameter from /authorize.
  // The proxy never sees the redirect callback (Entra → client direct), so we
  // cannot compare round-trip values. Storing 'state' here closes the finding
  // by enabling audit-log correlation between /authorize and /token for the
  // same OAuth session, which is otherwise impossible across the PKCE bridge.
  // Optional: clients may omit 'state' — its absence is not itself an issue,
  // RFC 6749 §10.12 only RECOMMENDS it.
  clientState?: string;
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
