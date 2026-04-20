import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import logger from './logger.js';

export interface UserTokenValidatorOptions {
  tenantId: string;
  expectedAudiences: string[];
  authorizedUserOids: string[];
}

export interface UserTokenClaims {
  oid: string;
  upn?: string;
  name?: string;
  appid?: string;
}

interface UserTokenPayload {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  oid?: string;
  upn?: string;
  preferred_username?: string;
  name?: string;
  tid?: string;
  appid?: string;
  azp?: string;
  scp?: string;
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
      if (err) return reject(err);
      if (!key) return reject(new Error('No signing key found'));
      resolve(key.getPublicKey());
    });
  });
}

function audienceMatches(tokenAud: string | string[] | undefined, expected: string[]): boolean {
  if (!tokenAud || expected.length === 0) return false;
  const list = Array.isArray(tokenAud) ? tokenAud : [tokenAud];
  return list.some((a) => expected.includes(a));
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

    if (payload.tid && payload.tid !== options.tenantId) {
      logger.warn(`User token tenant mismatch: tid=${payload.tid}, expected=${options.tenantId}`);
      return null;
    }

    if (!audienceMatches(payload.aud, options.expectedAudiences)) {
      logger.warn(
        `User token audience not in expected list: aud=${JSON.stringify(payload.aud)}, expected=${JSON.stringify(options.expectedAudiences)}`
      );
      return null;
    }

    const oid = payload.oid;
    if (!oid) {
      logger.warn('User token missing oid claim');
      return null;
    }

    if (options.authorizedUserOids.length > 0 && !options.authorizedUserOids.includes(oid)) {
      logger.warn(
        `User oid ${oid} (${payload.upn || payload.preferred_username || 'no upn'}) not in authorized-users allowlist`
      );
      return null;
    }

    return {
      oid,
      upn: payload.upn || payload.preferred_username,
      name: payload.name,
      appid: payload.appid || payload.azp,
    };
  } catch (error) {
    logger.error(`User token validation failed: ${(error as Error).message}`);
    return null;
  }
}
