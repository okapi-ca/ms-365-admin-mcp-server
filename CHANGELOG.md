# Changelog

All notable changes to `ms-365-admin-mcp-server` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Tool counts in parentheses indicate the cumulative total after the change.

## [Unreleased]

## [0.1.0] — 2026-04-17

Initial public release. **515 tools** covering Microsoft 365 admin operations via Graph API application permissions.

### Added

- 71 admin write endpoints, bringing the total to **515 tools** (#26)
- eDiscovery hold actions exposed via the `response` preset
- Complete documentation set: `USE_CASES`, `APP_REGISTRATION`, `HTTP_DEPLOYMENT`, `TROUBLESHOOTING`, `ARCHITECTURE`, `RISK_MODEL` (#29, #30)
- `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` (MIT), `CHANGELOG.md`
- `.github/PULL_REQUEST_TEMPLATE.md` and issue templates
- Published to npm as `@okapi_ca/ms-365-admin-mcp-server` and to GHCR as `ghcr.io/okapi-ca/ms-365-admin-mcp-server`

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

[Unreleased]: https://github.com/okapi-ca/ms-365-admin-mcp-server/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/okapi-ca/ms-365-admin-mcp-server/releases/tag/v0.1.0
