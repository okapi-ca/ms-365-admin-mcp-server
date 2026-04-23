import type { Express, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * Installs the OAuth surface rate limiters on `/authorize`, `/token`,
 * `/register`, and `/devicecode`. Kept in its own module (no transitive
 * imports of the MCP SDK or JWKS stack) so tests can exercise the split
 * without loading the entire server.
 *
 * Split policy on /token, by `grant_type`:
 *  - Tight (10 req/min): `authorization_code` + `refresh_token`.
 *    One-shot per auth flow, high volume = brute-force suspect.
 *  - Loose (60 req/min): `urn:ietf:params:oauth:grant-type:device_code`.
 *    RFC 8628 §3.5 requires clients to poll at the server-provided
 *    `interval` (Entra returns 5 s → 12 req/min/bootstrap). The tight
 *    10/min cap broke the flow before MFA could complete — observed in
 *    prod on v0.6.0 (Marc's admin bootstrap, 2026-04-23T13:29Z).
 *    60/min = 1 req/sec average, still bounds brute-force: device_codes
 *    are high-entropy (Entra issues 32+ char random values), /devicecode
 *    itself stays tight at 10/min, and codes expire in 15 min regardless.
 *
 *  Fallback: unknown / missing grant_type → tight limiter (safe default).
 *
 *  Must be called AFTER `express.urlencoded()` / `express.json()` so
 *  req.body is populated when the middleware inspects grant_type.
 */
export function registerOAuthRateLimiters(app: Express): void {
  app.use(
    '/authorize',
    rateLimit({
      windowMs: 60_000,
      max: 30,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'invalid_request', error_description: 'Too many authorize requests' },
    })
  );
  const tokenTightLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'invalid_request', error_description: 'Too many token requests' },
  });
  const tokenDevicePollLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'invalid_request',
      error_description: 'Too many device_code poll requests',
    },
  });
  app.use('/token', (req: Request, res: Response, next: NextFunction) => {
    const grantType = typeof req.body?.grant_type === 'string' ? req.body.grant_type : '';
    if (grantType === DEVICE_CODE_GRANT) {
      tokenDevicePollLimiter(req, res, next);
      return;
    }
    tokenTightLimiter(req, res, next);
  });
  app.use('/register', tokenTightLimiter);
  // /devicecode issues upstream device_codes and is called once per
  // bootstrap — tight limiter is correct here.
  app.use('/devicecode', tokenTightLimiter);
}
