# Security Review — 2026-04-20

Internal security review focused on Priority 1 of the broader audit: **Auth / OAuth HTTP mode** (`src/oauth-proxy.ts`, `src/token-validator.ts`, `src/user-token-validator.ts`, `src/http-server.ts`, `src/auth.ts`).

Purpose of this document: provide a traceable register of findings. Each finding has a stable `SEC-Fxx` identifier so remediation PRs and future reviews can reference it cleanly.

**Reviewer:** Marc Bourget (VP IT, LCI Education) with Claude Code assistance.
**Commit reviewed:** `main` @ `418ee16` (post-merge of playbooks PR #42).
**Scope:** Priority 1 only (OAuth flow + token validation + HTTP transport wiring). Priorities 2–6 remain open — see the [next-steps](#next-steps) section.

---

## Architectural premise

Confirmed by inspection of [src/auth.ts:111](../src/auth.ts):

```ts
const result = await this.msalApp.acquireTokenByClientCredential({
  scopes: ['https://graph.microsoft.com/.default'],
});
```

The server authenticates to Microsoft Graph with **client_credentials** (application permissions), independent of the calling user. A user's JWT is used only as an **authentication gate** on `/mcp`; it is not a delegated authorization token for Graph. As a result, the server's capability ceiling is set by the Entra app registration's consented app-permissions, not by any individual user's scopes.

Implication for this review: any weakness in the user-token authentication gate (e.g. an empty allowlist, a missing scope check) directly elevates an authenticated tenant user to the server's full Graph capability. This makes SEC-F01 and SEC-F03 the highest-priority findings even though each looks innocuous in isolation.

---

## Findings register

Severity rubric mirrors [RISK_MODEL.md](RISK_MODEL.md) but is calibrated to security vulns (CVSS-like): **Critical** = remote unauthenticated/any-user exploit with broad impact; **High** = requires a plausible precondition; **Medium** = operational hardening with realistic exploit chain; **Low** = defence-in-depth / hygiene.

### SEC-F01 — `authorizedUserOids = []` fails open silently

- **Severity:** Critical
- **Status:** Fixed — this review cycle
- **Location:** [src/user-token-validator.ts:110](../src/user-token-validator.ts) (pre-fix).
- **Description:** The guard read `if (options.authorizedUserOids.length > 0 && !includes(oid)) reject`. An empty allowlist skipped the check and accepted every signed token from the tenant.
- **Attack scenario:** An operator runs `--oauth-mode` without `--authorized-users`. Any Entra user in the tenant who completes the OAuth flow and obtains a token with the expected audience gets app-permission-level Graph access.
- **Remediation:** Fail-closed. Added `allowAnyTenantUser: boolean` to `UserTokenValidatorOptions`. When the allowlist is empty and the flag is false, every token is rejected with a logged warning. The server refuses to start if OAuth mode is enabled without at least one of `--authorized-users` / `--allow-any-tenant-user`.
- **Tests:** `test/user-token-validator.test.ts` — _SEC-F01 fail-closed authorization_ block.
- **Breaking change:** Yes. Deployments relying on the implicit behaviour must now pass `--allow-any-tenant-user` explicitly.

### SEC-F02 — `resolveIssuer` trusts `X-Forwarded-*` in the fallback path

- **Severity:** High
- **Status:** Fixed — sprint 2
- **Location:** [src/oauth-proxy.ts](../src/oauth-proxy.ts), [src/http-server.ts](../src/http-server.ts).
- **Description:** When `publicUrl` was not configured, the proxy derived the advertised OAuth issuer from `X-Forwarded-Proto` / `X-Forwarded-Host` / `Host`. `app.set('trust proxy', 1)` bounds that trust to a single upstream hop, which is appropriate only behind a known-and-trusted reverse proxy.
- **Attack scenario:** In a direct-exposure deploy (no reverse proxy), a client-supplied `Host` header was echoed into `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`. A victim client performing metadata discovery could be steered to an attacker-controlled issuer and intercepted.
- **Remediation:** `--public-url` is now mandatory when `--oauth-mode` is enabled, validated at startup (`server.ts`) and again at OAuth-route registration (`registerOAuthRoutes` throws). The header-derived fallback was removed from both `oauth-proxy.ts` and `http-server.ts` (`resourceMetadataUrl` now takes a non-optional string). The advertised issuer is deterministic and independent of request headers.
- **Breaking change:** Yes. Deployments that did not pass `--public-url` must add it.

### SEC-F03 — `scp` claim parsed but never enforced

- **Severity:** High
- **Status:** Fixed — this review cycle
- **Location:** [src/user-token-validator.ts](../src/user-token-validator.ts) (pre-fix — `scp` was declared in `UserTokenPayload` but never read).
- **Description:** A user token whose `scp` claim contains only `openid profile email` (for example) was accepted as though it had consented to the administrative API scope. Combined with the app-permission execution model, this trivially elevated a non-admin consent to admin Graph capability.
- **Attack scenario:** Consent phishing with a benign-looking scope set → token lands on `/mcp` → full admin-grade Graph operations.
- **Remediation:** Added `requiredScopes: string[]` to `UserTokenValidatorOptions`, enforced against the space-separated `scp` claim. Default is `['access_as_user']` (matches the scope the proxy itself requests at `/authorize`). Override via `--required-user-scopes <scopes>`; pass `""` to disable.
- **Tests:** `test/user-token-validator.test.ts` — _SEC-F03 required scope enforcement_ block.
- **Breaking change:** Yes for any deployment that used a different scope name or relied on no scope check.

### SEC-F04 — `refresh_token` grant requires no MCP-client authentication

- **Severity:** High
- **Status:** Partially mitigated — sprint 2. Residual risk tracked.
- **Location:** [src/oauth-proxy.ts](../src/oauth-proxy.ts).
- **Description:** `POST /token` with `grant_type=refresh_token` attaches the server's `client_secret` and forwards the refresh token to Entra. An attacker in possession of a refresh token only needs the public proxy URL to redeem it — the client_secret Entra would normally require is supplied by the proxy on behalf of the caller.
- **Attack scenario:** Refresh-token exfiltration from an MCP client (local token store, logs, MITM) is directly usable via the proxy, without the additional factor of the client_secret.
- **Mitigation delivered (sprint 2):** `/token` is now rate-limited at 10 req/min per IP (see SEC-F06), which bounds brute-force throughput and makes scripted abuse visible in logs. This does **not** close the underlying architectural gap — one stolen refresh token used once is still redeemable.
- **Residual risk:** Stolen-refresh-token reuse remains possible until either (a) the proxy becomes a confidential client to MCP callers (per-client credentials, moving away from `token_endpoint_auth_methods: none`), or (b) the proxy requires a bound proof-of-possession on refresh (DPoP, mTLS, or a session-bound bearer). Both are architectural changes tracked separately as a future SEC-F04b.
- **Operational compensations:** keep refresh-token lifetimes short in the Entra app registration (default 90 days is too long for an admin surface; consider dropping to 24h via Conditional Access sign-in frequency); monitor the `10 req/min` rate-limit hits on `/token` for anomalous clients.

### SEC-F05 — PKCE bridge is in-memory per process

- **Severity:** Medium
- **Status:** Mitigated — sprint 3 (infra + documentation). Architectural externalisation tracked.
- **Location:** [src/oauth-proxy.ts](../src/oauth-proxy.ts).
- **Description:** A process-local `Map<string, PkceEntry>` holds the server-side PKCE verifier between `/authorize` and `/token`. In a multi-replica deployment, the two requests may land on different instances and the bridge lookup fails.
- **Attack scenario:** No direct exploit, but the availability failure creates pressure for ad-hoc fixes that degrade security (e.g. shortening `PKCE_TTL_MS`, removing PKCE, or relaxing the bridge lookup).
- **Mitigation delivered (sprint 3):** [infra/main.bicep](../infra/main.bicep) now defaults `maxReplicas = 1` with an inline SEC-F05 note explaining why. Operators who scale past one replica must explicitly override the parameter — forcing them to acknowledge the broken flow before they break it. Documented in [HTTP_DEPLOYMENT.md](HTTP_DEPLOYMENT.md).
- **Residual risk:** This is an availability/operational constraint, not a remediation. A horizontally-scalable deployment still requires externalising the bridge (Redis / Azure Cosmos / Azure Table with the same 10-minute TTL). Tracked as a follow-up under the same SEC-F05 ID; re-open on this document when the feature is scheduled.

### SEC-F06 — `/token` and `/authorize` have no rate limit

- **Severity:** Medium
- **Status:** Fixed — sprint 2
- **Location:** [src/http-server.ts](../src/http-server.ts).
- **Description:** The `express-rate-limit` middleware was mounted on `/mcp` only. `/authorize`, `/token`, and `/register` were uncapped, enabling brute force of authorization codes and enumeration of refresh tokens (see SEC-F04).
- **Remediation:** Added two dedicated rate limiters, both active only when `--oauth-mode` is enabled:
  - `/authorize`: 30 req/min per IP (user-initiated redirect, looser bound).
  - `/token` and `/register`: 10 req/min per IP (token exchange is the brute-force target).
- **Note:** Limits are process-local. In a multi-replica deployment the effective budget scales with the replica count; SEC-F05 (externalize transient state) is the follow-up that would restore a single shared budget.

### SEC-F07 — `/token` logs up to 500 chars of upstream error payload

- **Severity:** Medium
- **Status:** Fixed — sprint 3
- **Location:** [src/oauth-proxy.ts](../src/oauth-proxy.ts), [src/upstream-error.ts](../src/upstream-error.ts).
- **Description:** On upstream HTTP error, the proxy used to log `payload.slice(0, 500)`. Entra error bodies contain `correlation_id`, `trace_id`, server-generated prose, and occasionally diagnostic hints that have no place in our logs.
- **Remediation:** Extracted `summarizeUpstreamError` into a pure module and delegated logging to it. Only the RFC 6749 fields `error`, `error_description` (clipped to 200 chars, whitespace-collapsed), and the Microsoft `error_codes` numeric array (first 5) are emitted. Non-JSON payloads log `<unparseable N bytes>`; JSON without recognised fields logs `<no recognised oauth error fields>`. 7 unit tests in [test/upstream-error.test.ts](../test/upstream-error.test.ts) cover the extraction, clipping, whitespace normalisation, and both fallback paths.

### SEC-F08 — No stale-while-revalidate on JWKS cache

- **Severity:** Medium
- **Status:** Fixed — sprint 3
- **Location:** [src/token-validator.ts](../src/token-validator.ts), [src/user-token-validator.ts](../src/user-token-validator.ts), [src/jwks-stale-cache.ts](../src/jwks-stale-cache.ts).
- **Description:** `jwks-rsa` cache TTL was 10 minutes. A JWKS outage outlasting the cache window caused token validation to fail outright.
- **Remediation:** Two layers:
  - `cacheMaxAge` raised from 10 minutes to 24 hours on the in-library cache in both validators. Entra advertises new keys well before activation, so a longer TTL is safe.
  - New pure module `jwks-stale-cache.ts` keeps a per-tenant `Map<kid, PEM>` of successfully-fetched keys. On a fetch failure, if a PEM for the same `kid` is cached, the wrapper serves it with a warning log. Truly unknown keys still fail closed (rethrow). This survives multi-hour JWKS outages without broadening trust — stale keys were already trusted when first fetched, and signatures remain valid until the key itself is rotated out. 5 unit tests in [test/jwks-stale-cache.test.ts](../test/jwks-stale-cache.test.ts) cover cache population, stale fallback, rethrow on unknown kid, and overwrite on refresh.

### SEC-F09 — Dynamic Client Registration is decorative

- **Severity:** Low
- **Status:** Open
- **Location:** [src/oauth-proxy.ts:93-105](../src/oauth-proxy.ts).
- **Description:** `/register` returns a synthesised `client_id` but stores nothing. `/token` ignores whatever the client sends and substitutes the server's configured `client_id` when talking to Entra. The endpoint misleads well-behaved clients and alters the advertised RFC 8414 metadata when enabled.
- **Remediation (proposed):** Either implement genuine DCR (persist, enforce) or remove the endpoint and the `registration_endpoint` line from the AS metadata.

### SEC-F10 — `redirect_uri` forwarded without local allowlist

- **Severity:** Low
- **Status:** Open
- **Location:** [src/oauth-proxy.ts:148](../src/oauth-proxy.ts).
- **Description:** The proxy forwards the client-supplied `redirect_uri` to Entra. Entra enforces its own app-registration allowlist, so a correctly-configured app registration mitigates this. The risk is purely operator hygiene: a wildcard or broadly permissive redirect URI in the app registration extends its laxness through the proxy.
- **Remediation (proposed):** Document explicitly that the Entra app registration's `redirectUris` are load-bearing; recommend exact-match URIs only (no `localhost:*` patterns, no wildcard).

### SEC-F11 — `/health` leaks the `transport` field

- **Severity:** Low
- **Status:** Open
- **Location:** [src/http-server.ts:60-62](../src/http-server.ts).
- **Description:** The health response includes `transport: "http"`. Trivial information leak.
- **Remediation (proposed):** Remove the `transport` field, or restrict `/health` to a loopback-bound path if the upstream probe can be configured accordingly.

---

## Observations (positive)

No remediation required — recorded so future reviews do not re-litigate already-correct decisions.

- JWT algorithm pinned to `['RS256']` in both validators; no `none` / `HS*` confusion surface.
- Both v1 (`sts.windows.net`) and v2 (`login.microsoftonline.com`) issuers accepted on the user-token path, matching Entra's dual-endpoint reality.
- Global security headers set by [src/http-server.ts:20-28](../src/http-server.ts) (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'`, `Referrer-Policy: no-referrer`).
- Request body size capped at `100kb` for both JSON and URL-encoded payloads.
- Grep across `src/` confirms no secrets or tokens are logged in any scanned code path.
- `SEC-NN` comment convention already in use (see existing `SEC-02`, `SEC-11`, `SEC-B` markers) — the new findings follow the same pattern.

---

## Remediation order (recommendation)

| Wave       | Findings                                                                               | Rationale                                                                                                |
| ---------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1 — PR #44 | SEC-F01 (fixed), SEC-F03 (fixed)                                                       | Critical + High exploitable at the current deployment state.                                             |
| 2 — PR #46 | SEC-F02 (fixed), SEC-F06 (fixed), SEC-F04 (partial: rate-limited + documented)         | Harden the public OAuth proxy surface before broader exposure.                                           |
| 3 — PR #47 | SEC-F07 (fixed), SEC-F08 (fixed), SEC-F05 (mitigated via single-replica Bicep default) | Log hygiene, availability robustness, multi-replica guardrail.                                           |
| Follow-ups | SEC-F04b (refresh-token PoP), SEC-F05 architectural (externalise PKCE bridge)          | Architectural work — larger PRs with new runtime dependencies. Track separately when scheduling arrives. |
| Backlog    | SEC-F09, SEC-F10, SEC-F11                                                              | Documentation / cosmetic; no realistic exploit path.                                                     |

---

## Next steps

The broader audit plan identified six priority areas. Status after this cycle:

- **P1 — Auth / OAuth HTTP mode** — substantially remediated. Closed: SEC-F01, SEC-F02, SEC-F03, SEC-F06, SEC-F07, SEC-F08. Partially mitigated: SEC-F04 (rate-limited; architectural PoP fix as SEC-F04b) and SEC-F05 (single-replica default; architectural externalisation still open). Open-backlog: SEC-F09, SEC-F10, SEC-F11.
- **P2 — Tool invocation gating** — not yet reviewed. Verify `--allow-writes` enforcement at dispatch, audit risk-level labels, assess prompt-injection via Graph response content.
- **P3 — Secret & token hygiene** — pass-level check done (no logging observed); formal pass pending.
- **P4 — Transport & deploy hardening** — CORS, HSTS, trust-proxy depth, rate-limit breadth.
- **P5 — Supply chain** — `npm audit`, base-image pinning, generator pipeline integrity.
- **P6 — Threat-model document** — not yet written; should consolidate this register with `RISK_MODEL.md` into a unified threat model.

This document is the authoritative register for P1 findings. Update in place as findings are closed; add follow-up reviews as `docs/SECURITY_REVIEW_YYYY-MM-DD.md` dated files.
