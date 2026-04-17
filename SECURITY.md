# Security Policy

## Supported versions

Only the latest release of `ms-365-admin-mcp-server` receives security updates. Older versions may contain vulnerabilities that have been fixed upstream.

| Version | Supported |
| ------- | --------- |
| `main`  | Yes       |
| < main  | No        |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately via one of these channels:

- GitHub's [private vulnerability reporting](https://github.com/okapi-ca/ms-365-admin-mcp-server/security/advisories/new) (preferred)
- Email the maintainer listed in the GitHub organization profile

Include in your report:

- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept if possible)
- Affected version (commit SHA or release tag)
- Suggested remediation, if any

## Response process

- **Acknowledgment** — within 5 business days
- **Initial assessment** — within 10 business days
- **Fix and disclosure** — coordinated with the reporter; typically within 90 days depending on severity

## Scope

The following are in scope for security reports:

- Authentication and authorization bypass (stdio and HTTP transports)
- JWT validation flaws in HTTP mode (issuer, audience, signature, tenant, client ID)
- Token leakage in logs, error responses, or traces
- Path traversal, SSRF, or command injection via tool parameters
- Privilege escalation via unexpected Graph API calls
- Risk-level misclassification of write tools (e.g. `critical` operation marked as `low`)
- Supply chain issues in direct dependencies

Out of scope:

- Issues requiring physical access to the MCP host
- Social engineering of MCP operators
- Denial-of-service via resource exhaustion on the local process (the server is expected to be run with OS-level limits)
- Vulnerabilities in Microsoft Graph API itself (report those to Microsoft MSRC)

## Hardening checklist for operators

If you run this server, we recommend:

1. **Least-privilege credentials.** Grant only the Graph API application permissions you actually need. Use `--preset` and `--enabled-tools` to scope the tool surface.
2. **Read-only by default.** Do not pass `--allow-writes` unless a scenario requires mutations.
3. **Secret management.** Store `MS365_ADMIN_MCP_CLIENT_SECRET` in Azure Key Vault (`MS365_ADMIN_MCP_KEYVAULT_URL`), never in plain environment files committed to source control.
4. **Certificate authentication.** Prefer certificates over client secrets where possible (planned; see `CHANGELOG.md`).
5. **Secret rotation.** Rotate client secrets every 90 days; federated credentials and managed identity remove this burden.
6. **HTTP mode exposure.** Never expose the HTTP transport on `0.0.0.0` without a reverse proxy enforcing TLS and additional authentication. Always pass `--allowed-clients` with the minimum set of Entra app IDs.
7. **Audit trail.** Enable verbose logging (`-v`) and forward logs to a SIEM. All Graph mutations are also auditable via `list-directory-audits` and `list-intune-audit-events`.
8. **Network segmentation.** Run the server in a network segment that only permits egress to `login.microsoftonline.com` and `graph.microsoft.com` (or sovereign equivalents).

## Known hardening in this codebase

The following defenses are already implemented (see inline `SEC-*` comments in `src/`):

- JWT signature verification via Microsoft JWKS (RS256), issuer, audience, tenant, and client ID checks (`src/token-validator.ts`)
- Rate limiting: 100 req/min on `/mcp` (`src/http-server.ts`)
- Security headers: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Cache-Control: no-store`, CSP `default-src 'none'`
- Body size limit: 100 KB
- Path parameter validation against traversal (`../`, `/`, `\`, `?`, `#`, `&`) for `skipEncoding` params
- ReDoS protection: `--enabled-tools` regex capped at 500 chars
- Sensitive data redacted from logs
- Tenant `common` rejected (single-tenant required for client credentials)
- Non-root Docker user
- Sanitized query strings in error messages (no secret leakage)
