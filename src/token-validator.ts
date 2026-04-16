import logger from './logger.js';

export interface TokenValidatorOptions {
  tenantId: string;
  allowedClientIds: string[];
}

interface JwtPayload {
  iss?: string;
  aud?: string;
  exp?: number;
  appid?: string;
  azp?: string;
}

function decodeJwtPayload(token: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
  return JSON.parse(payload) as JwtPayload;
}

export async function validateEntraToken(
  token: string,
  options: TokenValidatorOptions
): Promise<boolean> {
  try {
    const payload = decodeJwtPayload(token);

    if (!payload.iss || !payload.iss.includes(options.tenantId)) {
      logger.warn(`Token issuer mismatch: ${payload.iss}`);
      return false;
    }

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      logger.warn('Token expired');
      return false;
    }

    const clientId = payload.appid || payload.azp;
    if (!clientId || !options.allowedClientIds.includes(clientId)) {
      logger.warn(`Token client ID not allowed: ${clientId}`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`Token validation failed: ${(error as Error).message}`);
    return false;
  }
}
