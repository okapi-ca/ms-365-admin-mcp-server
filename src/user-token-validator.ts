import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import logger from './logger.js';
import {
  authorizeUserClaims,
  type UserTokenClaims,
  type UserTokenPayload,
  type UserTokenValidatorOptions,
} from './user-token-authorization.js';

export { authorizeUserClaims } from './user-token-authorization.js';
export type {
  UserTokenClaims,
  UserTokenPayload,
  UserTokenValidatorOptions,
} from './user-token-authorization.js';

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
      if (err) return reject(err);
      if (!key) return reject(new Error('No signing key found'));
      resolve(key.getPublicKey());
    });
  });
}

export async function validateUserToken(
  token: string,
  options: UserTokenValidatorOptions
): Promise<UserTokenClaims | null> {
  try {
    const client = getJwksClient(options.tenantId);

    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string') {
      logger.warn('User token could not be decoded');
      return null;
    }

    const publicKey = await getSigningKey(client, decoded.header);

    const payload = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: [
        `https://login.microsoftonline.com/${options.tenantId}/v2.0`,
        `https://sts.windows.net/${options.tenantId}/`,
      ],
      clockTolerance: 30,
    }) as UserTokenPayload;

    return authorizeUserClaims(payload, options);
  } catch (error) {
    logger.error(`User token validation failed: ${(error as Error).message}`);
    return null;
  }
}
