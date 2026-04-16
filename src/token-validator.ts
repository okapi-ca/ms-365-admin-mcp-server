import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import logger from './logger.js';

export interface TokenValidatorOptions {
  tenantId: string;
  allowedClientIds: string[];
  expectedAudience?: string;
}

interface EntraTokenPayload {
  iss?: string;
  aud?: string;
  exp?: number;
  appid?: string;
  azp?: string;
  tid?: string;
}

const jwksClients = new Map<string, jwksRsa.JwksClient>();

function getJwksClient(tenantId: string): jwksRsa.JwksClient {
  let client = jwksClients.get(tenantId);
  if (!client) {
    client = jwksRsa({
      jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
      cache: true,
      cacheMaxAge: 600_000,
      rateLimit: true,
    });
    jwksClients.set(tenantId, client);
  }
  return client;
}

function getSigningKey(client: jwksRsa.JwksClient, header: jwt.JwtHeader): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!header.kid) {
      reject(new Error('JWT header missing kid'));
      return;
    }
    client.getSigningKey(header.kid, (err, key) => {
      if (err) {
        reject(err);
        return;
      }
      if (!key) {
        reject(new Error('No signing key found'));
        return;
      }
      resolve(key.getPublicKey());
    });
  });
}

export async function validateEntraToken(
  token: string,
  options: TokenValidatorOptions
): Promise<boolean> {
  try {
    const client = getJwksClient(options.tenantId);

    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string') {
      logger.warn('Token could not be decoded');
      return false;
    }

    const publicKey = await getSigningKey(client, decoded.header);

    const payload = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: `https://login.microsoftonline.com/${options.tenantId}/v2.0`,
      clockTolerance: 30,
    }) as EntraTokenPayload;

    // SEC-02: Verify audience
    if (options.expectedAudience) {
      if (payload.aud !== options.expectedAudience) {
        logger.warn('Token audience mismatch');
        return false;
      }
    }

    // Verify tenant ID from token payload
    if (payload.tid && payload.tid !== options.tenantId) {
      logger.warn('Token tenant ID mismatch');
      return false;
    }

    // Verify client ID is in the allowed list
    const clientId = payload.appid || payload.azp;
    if (!clientId || !options.allowedClientIds.includes(clientId)) {
      logger.warn('Token client ID not in allowed list');
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`Token validation failed: ${(error as Error).message}`);
    return false;
  }
}
