# Changelog

All notable changes to `ms-365-admin-mcp-server` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Tool counts in parentheses indicate the cumulative total after the change.

## [Unreleased]

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
