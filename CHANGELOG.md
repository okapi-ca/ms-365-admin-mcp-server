# Changelog

All notable changes to `ms-365-admin-mcp-server` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Tool counts in parentheses indicate the cumulative total after the change.

## [Unreleased]

### Added — device_code OAuth flow (RFC 8628)

Closes the last remaining auth friction for admin users whose host can't complete the authorization_code + PKCE flow in a browser. Primary triggers on Marc's infra:

- **macOS Platform SSO** intercepts WebKit/Safari OAuth redirects to Entra's broker, breaking the `localhost:14543/oauth/callback` leg.
- **Headless Docker / devcontainer / Codespaces / remote SSH** have no browser at all.
- Admin users who prefer doing MFA on a trusted device (phone) rather than on the host running the MCP client.

Server changes:

- `/.well-known/oauth-authorization-server` now advertises `device_authorization_endpoint` and the `urn:ietf:params:oauth:grant-type:device_code` grant.
- New `POST /devicecode` relays to Entra's devicecode endpoint with the same SEC-F04b client authentication (DCR `client_id` + `client_secret`) required on `/token`. `offline_access` is merged into the upstream scope so refresh tokens are issued.
- `POST /token` accepts the device_code grant and relays `authorization_pending` / `slow_down` / `expired_token` / `access_denied` verbatim so the poller can react per RFC 8628 §3.5.
- `/devicecode` shares the tight `/token` rate limiter (10 req/min).

New binary `ms-365-admin-mcp-auth` (shipped alongside the server):

- `npx @okapi-ca/ms-365-admin-mcp-server auth --server <url>` performs the full device_code bootstrap: DCR `/register`, `POST /devicecode`, polls `/token`, writes `<hash>_client_info.json` and `<hash>_tokens.json` into `~/.mcp-auth/mcp-remote-<version>/` (mode 0600).
- Cache key = `md5(serverUrl)`, matching `mcp-remote`'s `getServerUrlHash` exactly; a regression test locks the hash against the known production URL.
- Best-effort clipboard copy (`pbcopy` / `clip` / `wl-copy` / `xclip`), auto-disabled under `CI=true` or non-TTY.
- Documented exit codes (0 ok, 1 usage, 2 network, 3 denied, 4 timeout) for Docker / CI wrappers.
- `--cache-dir` + `MCP_REMOTE_CONFIG_DIR` env var honoured, so Docker bind mounts and multi-user setups work without patches.

Docs:

- `README.md` — new "Remote HTTP server: device_code authentication" section.
- `docs/TROUBLESHOOTING.md` — full section covering `Server disconnected`, Platform SSO symptoms, device_code flow walkthrough, Docker bind-mount patterns, Conditional Access caveat.

Tests: 19 new (11 server + 8 helper), 102 total.

## [0.4.0] — 2026-04-20

Closes the two architectural follow-ups left open by v0.3.0 (SEC-F04b refresh-token proof-of-possession, SEC-F05 PKCE bridge externalisation) by moving OAuth state to Azure Table Storage and turning the MCP DCR layer into a confidential-client issuer. A stolen refresh token is no longer redeemable without the per-client secret issued at `/register`, and the proxy can now run multi-replica.

### Breaking changes

Deployments running HTTP / OAuth mode will need configuration updates — see [Migration](#migration-040) below.

- **MCP clients must re-run Dynamic Client Registration.** Every `/register` call now returns a `client_secret`, and `/token` rejects any call (both `authorization_code` and `refresh_token` grants) missing valid `client_id` + `client_secret`. Existing clients that cached a `client_id` with `token_endpoint_auth_method: none` will get `invalid_client` on the next refresh — they must re-register. The MCP SDK handles this transparently at reconnect.
- **`--oauth-mode` now requires DCR** and refuses to start with `--no-dynamic-registration`. DCR is the issuance point for per-client credentials; disabling it defeats SEC-F04b.
- **`--oauth-mode` requires Azure Table Storage** in production (single-replica in-memory fallback still works for local dev/tests). Configure via env: `AZURE_STORAGE_ACCOUNT_NAME` (managed identity, recommended) or `AZURE_STORAGE_CONNECTION_STRING` (Azurite / dev).
- **Bicep `maxReplicas` default restored to 3** (SEC-F05 resolved). Storage Account + `oauthstate` table provisioned automatically, with `Storage Table Data Contributor` role granted to the UAMI.

### Security — OAuth / token validation (P1 architectural)

- **SEC-F04b** — `/token` now enforces per-client authentication on every grant (both `authorization_code` and `refresh_token`) using `client_secret_post` or `client_secret_basic`. `/register` issues a random 256-bit `client_secret` (stored as SHA-256 hash, compared via `crypto.timingSafeEqual`). `/authorize` rejects unknown `client_id`s and binds the PKCE entry to the `client_id`; `/token authorization_code` verifies the bound `client_id` matches the caller, preventing cross-client code redemption.
- **SEC-F05 (resolved)** — PKCE bridge + DCR client credentials are persisted in Azure Table Storage (`oauthstate` table, two partitions: `pkce`, `dcr`). Atomic consume via optimistic ETag delete. Managed-identity-only access (`allowSharedKeyAccess: false`).

### Added

- `src/storage/` — new `OAuthStorage` abstraction with `MemoryStorage` (tests/dev) and `TableStorage` (prod) implementations. Resolved by env at startup via `createOAuthStorage()`.
- 18 new unit tests covering storage behaviour, DCR secret issuance, `/authorize` client validation, `/token` client authentication (body + Basic auth), and cross-client PKCE rejection. Total: 72 tests (up from 54).
- `@azure/data-tables` ^13.3.2 as optional dependency. `@azure/identity` was already optional.
- Bicep: Storage Account (Standard_LRS, TLS 1.2, `allowSharedKeyAccess: false`, `defaultToOAuthAuthentication: true`), default table `oauthstate`, `Storage Table Data Contributor` role assignment to UAMI, `AZURE_STORAGE_ACCOUNT_NAME` / `AZURE_STORAGE_TABLE_NAME` env vars injected into the Container App.

### Migration {#migration-040}

- **Existing deployments**: run `az deployment group create` with the updated Bicep to provision the Storage Account + Table + role assignment. No data migration needed — PKCE entries are short-lived (10 min) and DCR re-registration is automatic.
- **MCP clients**: at next reconnect, the SDK will re-run DCR and receive a `client_secret`. Users may need to re-authorise once.
- **Local dev / tests**: works out of the box with `MemoryStorage` when neither `AZURE_STORAGE_ACCOUNT_NAME` nor `AZURE_STORAGE_CONNECTION_STRING` is set. For Azurite: set `AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;...;UseDevelopmentStorage=true`.
- Deployments that explicitly set `--no-dynamic-registration` must remove that flag (or disable `--oauth-mode`).

## [0.3.0] — 2026-04-20

Substantial security hardening after a two-priority review (P1 OAuth / P2 tool gating) — see [docs/SECURITY_REVIEW_2026-04-20.md](docs/SECURITY_REVIEW_2026-04-20.md) for the full findings register. Nine findings closed across five sprints, two partially mitigated with architectural follow-ups tracked. No critical, high, or medium vulnerabilities remain open across the reviewed surface.

### Breaking changes

Deployments running HTTP / OAuth mode will need configuration updates — see [Migration](#migration) below.

- **`--oauth-mode` now refuses to start** without either `--authorized-users <oids>` or the explicit opt-in `--allow-any-tenant-user` (SEC-F01). Previously an empty allowlist silently accepted every tenant user.
- **`--public-url` is strictly required with `--oauth-mode`** (SEC-F02). Header-derived issuer fallback removed; was already advertised as required behind a proxy, now validated at startup.
- **User tokens must carry `access_as_user` in `scp`** by default (SEC-F03). Override via `--required-user-scopes` or disable with `--required-user-scopes ""`.
- **Bicep `maxReplicas` default dropped from 3 to 1** (SEC-F05) because the PKCE bridge is in-memory per process.

### Security — OAuth / token validation (P1)

- **SEC-F01** — OAuth mode fails closed on empty user allowlist. New `--allow-any-tenant-user` opt-in required to accept every tenant user.
- **SEC-F02** — `--public-url` mandatory for `--oauth-mode`. `resolveIssuer` / `resourceMetadataUrl` header-based fallbacks removed; advertised issuer is deterministic.
- **SEC-F03** — New `--required-user-scopes` flag enforces scopes on the `scp` claim (default `access_as_user`).
- **SEC-F04 (partial)** — `/token` rate-limited at 10 req/min per IP. Architectural follow-up tracked as SEC-F04b (proof-of-possession / confidential client refactor).
- **SEC-F05 (mitigated)** — `infra/main.bicep` defaults to single replica, with inline note on externalising the PKCE bridge before horizontal scaling.
- **SEC-F06** — Dedicated rate limiters mounted on OAuth routes: 30/min on `/authorize`, 10/min on `/token` and `/register`.
- **SEC-F07** — `/token` upstream error logging restricted to RFC 6749 fields (`error`, `error_description`, `error_codes`) via the new pure `src/upstream-error.ts`. No more `correlation_id` / `trace_id` leakage.
- **SEC-F08** — JWKS cache TTL raised to 24 h and wrapped in a stale-while-revalidate fallback (`src/jwks-stale-cache.ts`). Brief Entra outages no longer cascade into blanket 403s; unknown `kid`s still fail closed.

### Security — Tool invocation gating (P2)

- **SEC-G01** — New `--max-risk-level <low|medium|high|critical>` CLI flag caps the risk level of registered tools (both reads and writes). Implies `--allow-writes`. Unannotated writes default to `critical` (fail-safe). Pure module `src/risk-level.ts` with `rank`, `effectiveRiskLevel`, `isToolAllowed`.
- **SEC-G02** — Every successful Graph tool response is wrapped in a nonce-delimited `<graph_response_NN>` envelope with an untrusted-data preamble before reaching the LLM. Defends against prompt injection through user-controlled Graph fields (displayName, mail subject, chat body, site title, OAuth app name, …). Per-call `crypto.randomBytes(8)` nonce prevents envelope escape.
- **SEC-G03** — 22 sensitive-read GETs annotated with `riskLevel`: 7 `high` (BitLocker recovery keys, LAPS passwords, eDiscovery cases/custodians/searches, subject-rights requests) and 15 `medium` (auth methods, sign-ins, risk detections, message traces, federated credentials, …). Tool descriptions now emit read-specific risk copy. Feeds SEC-G01: `--max-risk-level medium` hides BitLocker and LAPS from the tool surface.

### Added

- Pure, testable modules for every security-critical check: `src/user-token-authorization.ts`, `src/jwks-stale-cache.ts`, `src/upstream-error.ts`, `src/untrusted-envelope.ts`, `src/risk-level.ts`.
- 51 unit tests covering all five modules (up from zero coverage on these paths pre-review).
- [docs/SECURITY_REVIEW_2026-04-20.md](docs/SECURITY_REVIEW_2026-04-20.md) — traceable P1+P2 findings register with stable `SEC-Fxx` / `SEC-Gxx` identifiers.

### Migration

- Deployments relying on the implicit "any authenticated user" behaviour must add `--allow-any-tenant-user` to their startup command (and review whether that is actually intended).
- Deployments running `--oauth-mode` without `--public-url` must add `--public-url https://<fqdn>`. This was already documented as "required when behind a reverse proxy"; it is now strictly required.
- Deployments whose Entra app registration does not expose the `access_as_user` scope — or whose callers request a different scope — must pass `--required-user-scopes <their-scopes>` or `--required-user-scopes ""`.
- Bicep deployments that previously relied on `maxReplicas = 3` default now scale to a single replica by default. Multi-replica deployments must explicitly set `maxReplicas` and should externalise the PKCE bridge first (follow-up work tracked under SEC-F05).

## [0.2.4] — 2026-04-20

Fixes the StreamableHTTP transport so more than one `/mcp` request per process actually works. With the shared `McpServer` instance, the second call to `server.connect(transport)` threw `Already connected to a transport`, which surfaced as repeated 500s after the OAuth flow finally succeeded.

### Fixed

- HTTP mode now builds a fresh `McpServer` + `StreamableHTTPServerTransport` per request and closes both on `res.close`. The `server` parameter of `startHttpServer` is replaced with a `createServer: () => McpServer` factory.

## [0.2.3] — 2026-04-20

Fixes the OAuth 2.0 flow end-to-end: access tokens can now actually be validated by the MCP server. v0.2.0 → v0.2.2 produced `invalid signature` failures because Microsoft Graph access tokens (`aud=00000003-…`) are opaque and cannot be verified by third parties against the public JWKS.

### Changed

- OAuth proxy now defaults to requesting the app's own API scope (`api://<client-id>/access_as_user`) alongside `openid profile email offline_access`, so Entra issues a standard v2 JWT with `aud=<client-id>` signed with the tenant's publishable key.
- When the caller supplies custom `scopes`, the proxy honours them; otherwise it falls back to the app-owned scope above.

### Deployment note

The Entra app registration must expose the delegated scope `access_as_user` under `api://<client-id>` with `requestedAccessTokenVersion: 2`, and admin consent must be granted for that scope. This was done on the LCI deployment as part of the 0.2.3 rollout.

## [0.2.2] — 2026-04-20

Observability fix: logs were written only to files inside the container, so nothing showed up in Log Analytics and post-Entra OAuth failures were invisible.

### Changed

- HTTP transport now auto-enables the Winston Console transport (`-v` still forces it on stdio). stdio mode still keeps stdout clean for the JSON-RPC stream.
- OAuth proxy logs each `/authorize` redirect (redirect_uri, scope) and each `/token` exchange (`grant_type`, Entra HTTP status and body excerpt on failure).
- `/mcp` auth middleware logs 401/403 outcomes with the method/path.
- User-token validator failure logs now include the offending `aud`, `tid`, and `upn` so the root cause of a rejected token is obvious.

## [0.2.1] — 2026-04-20

Fixes the OAuth 2.0 discovery flow so Claude.ai Web and Claude Desktop can actually complete authorization against an OAuth-mode HTTP deployment.

### Fixed

- `/mcp` now returns `WWW-Authenticate: Bearer resource_metadata="…"` on `401` (missing token) and `WWW-Authenticate: Bearer resource_metadata="…", error="invalid_token"` on `403` (token validation failure). Without this header Claude clients could not discover the protected-resource metadata and surfaced `Authorization with the MCP server failed` before ever reaching `/authorize`.
- Express `trust proxy` is now set to `1` so `X-Forwarded-For` from the Container Apps / reverse-proxy edge stops tripping the `express-rate-limit` validator (`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`).

## [0.2.0] — 2026-04-19

Adds OAuth 2.0 proxy support to the HTTP transport so Claude Desktop, Claude Code, and Claude.ai Web remote MCP connectors can authenticate users through Entra ID without any client-side configuration beyond the server URL.

### Added

- `--oauth-mode` flag enables Entra-backed OAuth 2.0 + PKCE proxy endpoints on the HTTP transport:
  - `GET /.well-known/oauth-authorization-server` and `GET /.well-known/oauth-protected-resource` metadata
  - `POST /register` Dynamic Client Registration (stub returning a synthesized `client_id`)
  - `GET /authorize` 302 to Entra's authorize endpoint, with a two-leg PKCE bridge so the client's `code_challenge` never has to survive the round trip
  - `POST /token` exchanges `authorization_code` / `refresh_token` grants against Entra using the server-side verifier
- `--public-url` sets the issuer URL advertised in OAuth metadata (required behind a reverse proxy)
- `--authorized-users` is a comma-separated allowlist of Entra user `oid` claims; users outside the list get `403`
- `--no-dynamic-registration` opt-out for the DCR endpoint
- User-token validation (`src/user-token-validator.ts`) checks signature, issuer, tenant, audience, and the `oid` allowlist
- Bicep: new `oauthMode`, `authorizedUsers`, `publicUrl` parameters; `allowedClients` is now optional

### Changed

- `--allowed-clients` is no longer mandatory — HTTP transport now requires `--allowed-clients` or `--oauth-mode` (or both)
- `/mcp` auth middleware tries user-token validation first (if `--oauth-mode`), then service-token validation (if `--allowed-clients`), returning `403` only if both fail

### Security

- User tokens are used only as an authN gate — Graph calls still run with the server's application credentials, so an authenticated user does not gain access to anything beyond the server's granted roles

## [0.1.2] — 2026-04-19

First release that actually boots on Azure Container Apps end-to-end. The `0.1.0` Docker image crashed at startup because `src/generated/client.ts` was not generated in the builder stage. `0.1.1` was skipped on npm (version not bumped).

### Fixed

- Docker builder now runs `npm run generate` before `npm run build`, so the published image has the client bundle it needs at runtime (#34)
- Container entrypoint split into `command` + `args` in the reference Bicep, so `node` receives `dist/index.js` instead of treating `--transport` as its own flag (#34)
- Winston logger now uses `MS365_ADMIN_MCP_LOG_DIR=/tmp/...` by default in the Bicep template, avoiding `EACCES` against `/nonexistent/.ms365-admin-mcp/logs` when the image runs as a rootless user without a home directory (#34)

### Added

- `allowedClients` Bicep parameter (required; HTTP mode refuses to start without it) (#34)
- `tags` Bicep parameter propagated to every resource, required by org-level AppMapping/CapMapping tag policies (#34)
- `acrLoginServer` Bicep parameter + `registries` block using the UAMI for AcrPull, to support pulling from a private Azure Container Registry (#34)

## [0.1.0] — 2026-04-17

Initial public release. **515 tools** covering Microsoft 365 admin operations via Graph API application permissions.

### Added

- 71 admin write endpoints, bringing the total to **515 tools** (#26)
- eDiscovery hold actions exposed via the `response` preset
- Complete documentation set: `USE_CASES`, `APP_REGISTRATION`, `HTTP_DEPLOYMENT`, `TROUBLESHOOTING`, `ARCHITECTURE`, `RISK_MODEL` (#29, #30)
- `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` (MIT), `CHANGELOG.md`
- `.github/PULL_REQUEST_TEMPLATE.md` and issue templates
- Published to npm as `@okapi-ca/ms-365-admin-mcp-server` and to GHCR as `ghcr.io/okapi-ca/ms-365-admin-mcp-server`

### Security

- `set-application-verified-publisher` risk level bumped (#28)
- Query strings and `testLogin` error messages sanitized to avoid leaking secrets (#27)
- Removed dead dependency

## 444 tools

### Added

- 75 admin write operations (#25)
- 3 duplicate tool entries fixed during write expansion

## 369 tools

### Added

- 5 new endpoint categories (#24): Cloud PC, Teams call records, Universal Print, Information Protection, SharePoint admin
- Records Management

## 306 tools

### Added

- 107 high-value admin endpoints (#23): eDiscovery, Cloud PC, call records, print, info protection, SharePoint admin, records management, app credentials, guest users, external identity, Exchange, threat intelligence, Intune, Identity Governance

## 199 tools

### Security

- `dismiss-risky-users` elevated from `medium` to `high` risk (#22)
- Over-privileged permission scopes reduced to least-privilege

## Prior — 175 tools and earlier

### Added

- 117 endpoints restored after squash-merge loss (#21)
- Full security review with fixes (#20)
- 25 endpoints for devices, PIM, risk detections, administrative units (#19)
- 9 app credentials and management policy endpoints
- 10 guest users and external identity endpoints
- 20 Exchange and threat intelligence endpoints
- 31 Intune/device management endpoints
- 23 Identity Governance endpoints

### Infrastructure

- MCP server scaffolding with stdio and HTTP (StreamableHTTP) transports
- Azure AD client credentials flow via `@azure/msal-node`
- JWT validation via Microsoft JWKS in HTTP mode
- Preset-based tool filtering (`--preset`, `--enabled-tools`)
- Key Vault secret provider (`MS365_ADMIN_MCP_KEYVAULT_URL`)
- Multi-cloud support (global and China / 21Vianet)
- Azure Container Apps Bicep template
- Docker image with non-root user

---

[Unreleased]: https://github.com/okapi-ca/ms-365-admin-mcp-server/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/okapi-ca/ms-365-admin-mcp-server/releases/tag/v0.2.0
[0.1.2]: https://github.com/okapi-ca/ms-365-admin-mcp-server/releases/tag/v0.1.2
[0.1.0]: https://github.com/okapi-ca/ms-365-admin-mcp-server/releases/tag/v0.1.0
