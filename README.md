# ms-365-admin-mcp-server

[![CI](https://github.com/okapi-ca/ms-365-admin-mcp-server/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/okapi-ca/ms-365-admin-mcp-server/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@okapi-ca/ms-365-admin-mcp-server.svg)](https://www.npmjs.com/package/@okapi-ca/ms-365-admin-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for Microsoft 365 administration via Graph API **application permissions** (client credentials).

Built on the architecture and endpoint-driven design pioneered by [Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server), and complementary to it: Softeria's server uses **delegated** permissions for end-user productivity scenarios, while this one uses **application** permissions for admin operations — security monitoring, identity audits, incident response, and service health. See [Acknowledgments](#acknowledgments) below.

## Features

- **515 tools** covering security, audit, identity, app credentials, guest users, Exchange, Intune (devices, apps, MAM, reports), governance (PIM, access reviews, entitlement, lifecycle), compliance, threat intelligence, advanced hunting, Defender for Identity, Copilot admin, custom security attributes, LAPS, policies, reports, incident response, eDiscovery, Cloud PC, call records, Universal Print, information protection, SharePoint admin, and records management
- **Application permissions** (client credentials) — no user interaction required
- **Read-only by default** — write operations require explicit `--allow-writes`
- **Risk classification** on write tools (low/medium/high/critical)
- **Presets** to filter tools by domain (security, audit, identity, etc.)
- **Two transports**: stdio (default) and HTTP (StreamableHTTP)
- **Multi-cloud**: Microsoft global and China (21Vianet)
- **Key Vault** support for secrets management

## Documentation

| Document                                                               | Purpose                                                                     |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [docs/USE_CASES.md](docs/USE_CASES.md)                                 | 15 typical admin scenarios with sample prompts and tool lists               |
| [docs/playbooks/](docs/playbooks/README.md)                            | End-to-end security incident response playbooks                             |
| [agent-skills/](agent-skills/README.md)                                | Drop-in skills for LLM agents (Claude Code et al.) with safety patterns     |
| [docs/APP_REGISTRATION.md](docs/APP_REGISTRATION.md)                   | Step-by-step Azure AD app registration and permission consent               |
| [docs/HTTP_DEPLOYMENT.md](docs/HTTP_DEPLOYMENT.md)                     | HTTP transport, JWT validation, Docker, Azure Container Apps                |
| [docs/AZURE_DEPLOYMENT_SECURITY.md](docs/AZURE_DEPLOYMENT_SECURITY.md) | Threat model, required controls, and checklist for Azure production deploys |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)                     | Common errors and how to diagnose them                                      |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                           | Internal architecture and code generation pipeline                          |
| [docs/RISK_MODEL.md](docs/RISK_MODEL.md)                               | Risk classification rubric for write tools                                  |
| [CONTRIBUTING.md](CONTRIBUTING.md)                                     | How to contribute new tools, presets, and fixes                             |
| [SECURITY.md](SECURITY.md)                                             | Vulnerability reporting and operator hardening checklist                    |
| [CHANGELOG.md](CHANGELOG.md)                                           | Release history                                                             |

## Prerequisites

- Node.js >= 18
- An Azure AD app registration with **application permissions** (not delegated)
- A specific tenant ID (not "common")

## Installation

### npm (recommended)

```bash
npm install -g @okapi-ca/ms-365-admin-mcp-server
ms-365-admin-mcp-server --help
```

### Docker

```bash
docker pull ghcr.io/okapi-ca/ms-365-admin-mcp-server:latest
docker run --rm -i \
  -e MS365_ADMIN_MCP_CLIENT_ID=... \
  -e MS365_ADMIN_MCP_CLIENT_SECRET=... \
  -e MS365_ADMIN_MCP_TENANT_ID=... \
  ghcr.io/okapi-ca/ms-365-admin-mcp-server:latest
```

### From source

```bash
git clone https://github.com/okapi-ca/ms-365-admin-mcp-server.git
cd ms-365-admin-mcp-server
npm install
npm run generate
npm run build
```

## Configuration

### Environment variables

| Variable                        | Required | Description                                      |
| ------------------------------- | -------- | ------------------------------------------------ |
| `MS365_ADMIN_MCP_CLIENT_ID`     | Yes      | App registration client ID                       |
| `MS365_ADMIN_MCP_CLIENT_SECRET` | Yes      | App registration client secret                   |
| `MS365_ADMIN_MCP_TENANT_ID`     | Yes      | Azure AD tenant ID (must be specific)            |
| `MS365_ADMIN_MCP_CLOUD_TYPE`    | No       | `global` (default) or `china`                    |
| `MS365_ADMIN_MCP_KEYVAULT_URL`  | No       | Azure Key Vault URL (overrides env vars)         |
| `MS365_ADMIN_MCP_MAX_TOP`       | No       | Cap `$top` query param to limit result size      |
| `READ_ONLY`                     | No       | `true`/`1` to force read-only (default behavior) |
| `ENABLED_TOOLS`                 | No       | Regex to filter available tools                  |

### MCP client configuration (Claude Desktop, etc.)

```json
{
  "mcpServers": {
    "ms365-admin": {
      "command": "node",
      "args": ["/path/to/ms-365-admin-mcp-server/dist/index.js"],
      "env": {
        "MS365_ADMIN_MCP_CLIENT_ID": "your-client-id",
        "MS365_ADMIN_MCP_CLIENT_SECRET": "your-client-secret",
        "MS365_ADMIN_MCP_TENANT_ID": "your-tenant-id"
      }
    }
  }
}
```

### VS Code (1.102+)

VS Code consumes the same MCP protocol but uses a different config layout —
`servers` instead of `mcpServers`, an explicit `type` field, and `inputs` for
secret prompts. A ready-to-copy sample lives at
[`.vscode/mcp.json.example`](.vscode/mcp.json.example); copy it to
`.vscode/mcp.json` and VS Code will prompt for the tenant / client / secret on
first start, then store them in its secret store (the real `mcp.json` is
gitignored so resolved secrets never reach the repo).

Minimal stdio setup:

```jsonc
{
  "inputs": [
    { "type": "promptString", "id": "ms365-tenant-id",     "description": "Tenant ID" },
    { "type": "promptString", "id": "ms365-client-id",     "description": "Client ID" },
    { "type": "promptString", "id": "ms365-client-secret", "description": "Client secret", "password": true }
  ],
  "servers": {
    "ms365-admin": {
      "type": "stdio",
      "command": "ms-365-admin-mcp-server",
      "args": ["--preset", "security,audit,identity,health"],
      "env": {
        "MS365_ADMIN_MCP_TENANT_ID":     "${input:ms365-tenant-id}",
        "MS365_ADMIN_MCP_CLIENT_ID":     "${input:ms365-client-id}",
        "MS365_ADMIN_MCP_CLIENT_SECRET": "${input:ms365-client-secret}"
      }
    }
  }
}
```

For remote HTTP deployments, use `"type": "http"` with a `url` field (VS Code
1.103+ handles OAuth 2.0 Dynamic Client Registration natively) or fall back to
the `mcp-remote` bridge when the native browser flow is unavailable — see the
example file for both shapes.

Tools surface in **Agent mode** (GitHub Copilot Chat). VS Code asks for
per-tool approval; the `--preset` flag above keeps the catalog manageable.
Use `Cmd/Ctrl+Shift+P` → `MCP: List Servers` → `Show Output` to see logs.

### Remote HTTP server: device_code authentication (RFC 8628)

If the server runs in HTTP / OAuth mode on a remote host (e.g. Azure Container Apps) and the client connects via [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), the standard flow requires a browser to reach `localhost:14543/oauth/callback`. When that isn't possible — macOS Platform SSO hijacks the WebKit flow, Claude Code runs in a headless Docker container, the user is on a remote SSH dev env — use the `ms-365-admin-mcp-auth` bootstrap to pre-seed `mcp-remote`'s token cache instead.

```bash
npx @okapi-ca/ms-365-admin-mcp-server@latest auth \
  --server https://your-mcp-host.azurecontainerapps.io/mcp
```

The helper prints a URL and a user code; you sign in on **any device you trust** (phone, another laptop) and the tokens are written to `~/.mcp-auth/mcp-remote-<version>/`. Claude Desktop / Claude Code then launches `mcp-remote` normally and finds the cached tokens without ever opening a browser.

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md#oauth--browser-authentication-problems) for Docker / remote-dev patterns and exit code reference.

## Usage

### CLI options

```
--read-only              Read-only mode (default)
--allow-writes           Enable write operations
--enabled-tools <regex>  Filter tools by regex pattern
--preset <names>         Use preset categories (comma-separated)
--list-presets           List available presets and exit
--list-tools             List available tools and exit
--list-permissions       List required Graph API permissions and exit
--verify-login           Test credentials against Graph API and exit
--cloud <type>           Cloud environment: global (default) or china
--transport <type>       Transport: stdio (default) or http
--port <number>          HTTP port (default: 8080)
--host <address>         HTTP bind address (default: 127.0.0.1)
--allowed-clients <ids>  Comma-separated Entra app IDs (required for HTTP)
-v                       Verbose logging
```

### Presets

```bash
# Security alerts and incidents only
node dist/index.js --preset security

# Identity management tools
node dist/index.js --preset identity

# Multiple presets
node dist/index.js --preset security,audit,identity
```

| Preset            | Description                                                                 |
| ----------------- | --------------------------------------------------------------------------- |
| `security`        | Security alerts, incidents, attack simulations, and threat intelligence     |
| `audit`           | Directory audits, sign-ins, provisioning logs, deleted items                |
| `health`          | Service health and Message Center                                           |
| `reports`         | Usage reports (Teams, Email, SharePoint, OneDrive, Mailbox, M365 Apps)      |
| `identity`        | Users, groups, roles, devices, PIM, guest users, external identities        |
| `exchange`        | Exchange administration (message traces, mailboxes)                         |
| `intune`          | Managed devices, compliance, configurations, Autopilot, apps, RBAC          |
| `governance`      | Access reviews, entitlement management, lifecycle workflows, terms of use   |
| `compliance`      | Licenses, Secure Score, Identity Protection, risk detections, policies      |
| `response`        | Incident response write operations (disable, revoke, confirm, dismiss)      |
| `ediscovery`      | eDiscovery cases (Microsoft Purview)                                        |
| `cloudpc`         | Cloud PC / Windows 365 (provisioning, images, connections, settings, audit) |
| `callrecords`     | Teams call records                                                          |
| `print`           | Universal Print (printers, shares, connectors, services, operations, tasks) |
| `infoprotection`  | Information Protection (BitLocker recovery keys, threat assessment)         |
| `sharepointadmin` | SharePoint tenant administration settings                                   |
| `retention`       | Records Management (retention labels, file plan metadata)                   |
| `all`             | All available tools                                                         |

### Verify credentials

```bash
node dist/index.js --verify-login
```

## Available tools (515)

### Security (11)

| Tool                       | Method | Risk   |
| -------------------------- | ------ | ------ |
| `list-security-alerts`     | GET    |        |
| `get-security-alert`       | GET    |        |
| `update-security-alert`    | PATCH  | medium |
| `list-security-incidents`  | GET    |        |
| `get-security-incident`    | GET    |        |
| `update-security-incident` | PATCH  | medium |
| `list-attack-simulations`  | GET    |        |
| `get-attack-simulation`    | GET    |        |
| `create-attack-simulation` | POST   | high   |
| `update-attack-simulation` | PATCH  | medium |
| `delete-attack-simulation` | DELETE | medium |

### Audit logs & deleted items (5)

| Tool                     | Method |
| ------------------------ | ------ |
| `list-directory-audits`  | GET    |
| `list-sign-ins`          | GET    |
| `list-provisioning-logs` | GET    |
| `list-deleted-users`     | GET    |
| `list-deleted-groups`    | GET    |

### Service health (3)

| Tool                    | Method |
| ----------------------- | ------ |
| `list-service-health`   | GET    |
| `list-service-issues`   | GET    |
| `list-service-messages` | GET    |

### Usage reports (8)

| Tool                            | Method |
| ------------------------------- | ------ |
| `get-teams-activity-report`     | GET    |
| `get-email-activity-report`     | GET    |
| `get-active-users-report`       | GET    |
| `get-sharepoint-usage-report`   | GET    |
| `get-onedrive-usage-report`     | GET    |
| `get-active-user-counts-report` | GET    |
| `get-mailbox-usage-report`      | GET    |
| `get-m365-apps-usage-report`    | GET    |

### Users (10)

| Tool                     | Method | Risk     |
| ------------------------ | ------ | -------- |
| `list-users`             | GET    |          |
| `get-user`               | GET    |          |
| `list-user-memberships`  | GET    |          |
| `list-user-auth-methods` | GET    |          |
| `list-user-devices`      | GET    |          |
| `create-user`            | POST   | high     |
| `update-user`            | PATCH  | medium   |
| `delete-user`            | DELETE | critical |
| `assign-user-license`    | POST   | medium   |
| `reprocess-user-license` | POST   | low      |

### Devices (2)

| Tool           | Method |
| -------------- | ------ |
| `list-devices` | GET    |
| `get-device`   | GET    |

### Groups (8)

| Tool                 | Method | Risk     |
| -------------------- | ------ | -------- |
| `list-groups`        | GET    |          |
| `get-group`          | GET    |          |
| `list-group-members` | GET    |          |
| `list-group-owners`  | GET    |          |
| `create-group`       | POST   | medium   |
| `update-group`       | PATCH  | medium   |
| `delete-group`       | DELETE | critical |
| `add-group-member`   | POST   | medium   |

### Directory roles & PIM (7)

| Tool                            | Method | Risk     |
| ------------------------------- | ------ | -------- |
| `list-directory-roles`          | GET    |          |
| `list-role-members`             | GET    |          |
| `list-role-assignments`         | GET    |          |
| `list-role-definitions`         | GET    |          |
| `list-pim-eligible-assignments` | GET    |          |
| `list-pim-active-assignments`   | GET    |          |
| `add-directory-role-member`     | POST   | critical |

### Administrative units (7)

| Tool                               | Method | Risk   |
| ---------------------------------- | ------ | ------ |
| `list-administrative-units`        | GET    |        |
| `get-administrative-unit`          | GET    |        |
| `list-administrative-unit-members` | GET    |        |
| `create-administrative-unit`       | POST   | medium |
| `update-administrative-unit`       | PATCH  | medium |
| `delete-administrative-unit`       | DELETE | high   |
| `add-administrative-unit-member`   | POST   | medium |

### Conditional access (3)

| Tool                               | Method |
| ---------------------------------- | ------ |
| `list-conditional-access-policies` | GET    |
| `get-conditional-access-policy`    | GET    |
| `list-named-locations`             | GET    |

### Applications & app roles (8)

| Tool                             | Method | Risk     |
| -------------------------------- | ------ | -------- |
| `list-applications`              | GET    |          |
| `list-service-principals`        | GET    |          |
| `list-oauth2-grants`             | GET    |          |
| `list-user-app-role-assignments` | GET    |          |
| `list-sp-app-role-assignments`   | GET    |          |
| `update-application`             | PATCH  | high     |
| `delete-application`             | DELETE | critical |
| `update-service-principal`       | PATCH  | high     |

### App credentials & owners (7)

| Tool                             | Method |
| -------------------------------- | ------ |
| `get-application`                | GET    |
| `list-application-owners`        | GET    |
| `list-app-federated-credentials` | GET    |
| `get-app-federated-credential`   | GET    |
| `get-service-principal`          | GET    |
| `list-service-principal-owners`  | GET    |
| `list-sp-delegated-permissions`  | GET    |

### App management policies (2)

| Tool                           | Method |
| ------------------------------ | ------ |
| `list-app-management-policies` | GET    |
| `get-app-management-policy`    | GET    |

### Organization & domains (4)

| Tool               | Method | Risk   |
| ------------------ | ------ | ------ |
| `get-organization` | GET    |        |
| `list-domains`     | GET    |        |
| `create-domain`    | POST   | high   |
| `verify-domain`    | POST   | medium |

### Licenses (2)

| Tool                   | Method |
| ---------------------- | ------ |
| `list-subscribed-skus` | GET    |
| `get-subscribed-sku`   | GET    |

### Secure Score (4)

| Tool                         | Method |
| ---------------------------- | ------ |
| `list-secure-scores`         | GET    |
| `get-secure-score`           | GET    |
| `list-secure-score-controls` | GET    |
| `get-secure-score-control`   | GET    |

### Identity Protection & risk detections (7)

| Tool                            | Method |
| ------------------------------- | ------ |
| `list-risky-users`              | GET    |
| `get-risky-user`                | GET    |
| `list-risky-user-history`       | GET    |
| `list-risky-service-principals` | GET    |
| `get-risky-service-principal`   | GET    |
| `list-risk-detections`          | GET    |
| `get-risk-detection`            | GET    |

### Security & access policies (13)

| Tool                             | Method | Risk |
| -------------------------------- | ------ | ---- |
| `get-auth-methods-policy`        | GET    |      |
| `list-auth-method-configs`       | GET    |      |
| `get-auth-method-config`         | GET    |      |
| `get-security-defaults`          | GET    |      |
| `get-admin-consent-policy`       | GET    |      |
| `list-auth-strength-policies`    | GET    |      |
| `get-auth-strength-policy`       | GET    |      |
| `create-auth-strength-policy`    | POST   | high |
| `update-auth-strength-policy`    | PATCH  | high |
| `delete-auth-strength-policy`    | DELETE | high |
| `get-cross-tenant-access-policy` | GET    |      |
| `list-cross-tenant-partners`     | GET    |      |
| `change-user-password`           | POST   | high |

### Guest user invitations (2)

| Tool                | Method | Risk   |
| ------------------- | ------ | ------ |
| `list-invitations`  | GET    |        |
| `create-invitation` | POST   | medium |

### External identity providers (2)

| Tool                      | Method |
| ------------------------- | ------ |
| `list-identity-providers` | GET    |
| `get-identity-provider`   | GET    |

### Self-service sign-up (4)

| Tool                  | Method |
| --------------------- | ------ |
| `list-b2x-user-flows` | GET    |
| `get-b2x-user-flow`   | GET    |
| `list-api-connectors` | GET    |
| `get-api-connector`   | GET    |

### Custom authentication extensions (2)

| Tool                          | Method |
| ----------------------------- | ------ |
| `list-custom-auth-extensions` | GET    |
| `get-custom-auth-extension`   | GET    |

### Exchange message traces (2)

| Tool                  | Method |
| --------------------- | ------ |
| `list-message-traces` | GET    |
| `get-message-trace`   | GET    |

### Exchange mailboxes (7)

| Tool                            | Method | Risk     |
| ------------------------------- | ------ | -------- |
| `list-exchange-mailboxes`       | GET    |          |
| `get-exchange-mailbox`          | GET    |          |
| `list-exchange-mailbox-folders` | GET    |          |
| `get-exchange-mailbox-folder`   | GET    |          |
| `export-exchange-mailbox-items` | POST   | medium   |
| `update-exchange-mailbox`       | PATCH  | medium   |
| `delete-exchange-mailbox`       | DELETE | critical |

### Threat intelligence - hosts (4)

| Tool                           | Method |
| ------------------------------ | ------ |
| `list-threat-intel-hosts`      | GET    |
| `get-threat-intel-host`        | GET    |
| `get-threat-intel-host-whois`  | GET    |
| `list-threat-intel-host-pairs` | GET    |

### Threat intelligence - articles & profiles (6)

| Tool                                   | Method |
| -------------------------------------- | ------ |
| `list-threat-intel-articles`           | GET    |
| `get-threat-intel-article`             | GET    |
| `list-threat-intel-article-indicators` | GET    |
| `list-threat-intel-profiles`           | GET    |
| `get-threat-intel-profile`             | GET    |
| `list-threat-intel-profile-indicators` | GET    |

### Threat intelligence - vulnerabilities & WHOIS (4)

| Tool                                | Method |
| ----------------------------------- | ------ |
| `list-threat-intel-vulnerabilities` | GET    |
| `get-threat-intel-vulnerability`    | GET    |
| `list-threat-intel-whois-records`   | GET    |
| `get-threat-intel-whois-record`     | GET    |

### Threat intelligence - infrastructure (2)

| Tool                                | Method |
| ----------------------------------- | ------ |
| `list-threat-intel-host-components` | GET    |
| `list-threat-intel-ssl-certs`       | GET    |

### Managed devices (6)

| Tool                               | Method | Risk     |
| ---------------------------------- | ------ | -------- |
| `list-managed-devices`             | GET    |          |
| `get-managed-device`               | GET    |          |
| `list-device-compliance-states`    | GET    |          |
| `list-device-configuration-states` | GET    |          |
| `get-managed-device-overview`      | GET    |          |
| `delete-managed-device`            | DELETE | critical |

### Compliance policies (5)

| Tool                                     | Method |
| ---------------------------------------- | ------ |
| `list-compliance-policies`               | GET    |
| `get-compliance-policy`                  | GET    |
| `list-compliance-policy-device-statuses` | GET    |
| `get-compliance-policy-status-overview`  | GET    |
| `get-compliance-state-summary`           | GET    |

### Device configurations (3)

| Tool                                       | Method |
| ------------------------------------------ | ------ |
| `list-device-configurations`               | GET    |
| `get-device-configuration`                 | GET    |
| `get-device-configuration-status-overview` | GET    |

### Enrollment & Autopilot (10)

| Tool                              | Method | Risk   |
| --------------------------------- | ------ | ------ |
| `list-enrollment-configurations`  | GET    |        |
| `get-enrollment-configuration`    | GET    |        |
| `list-autopilot-devices`          | GET    |        |
| `get-autopilot-device`            | GET    |        |
| `create-enrollment-configuration` | POST   | medium |
| `update-enrollment-configuration` | PATCH  | medium |
| `delete-enrollment-configuration` | DELETE | high   |
| `update-autopilot-device`         | PATCH  | medium |
| `delete-autopilot-device`         | DELETE | high   |
| `import-autopilot-device`         | POST   | medium |

### Detected apps (3)

| Tool                        | Method |
| --------------------------- | ------ |
| `list-detected-apps`        | GET    |
| `get-detected-app`          | GET    |
| `list-detected-app-devices` | GET    |

### Intune RBAC & config (7)

| Tool                               | Method |
| ---------------------------------- | ------ |
| `list-intune-audit-events`         | GET    |
| `get-software-update-summary`      | GET    |
| `get-apple-push-certificate`       | GET    |
| `list-intune-role-definitions`     | GET    |
| `list-intune-role-assignments`     | GET    |
| `list-intune-terms-and-conditions` | GET    |
| `list-intune-terms-acceptances`    | GET    |

### Intune connectors & updates (3)

| Tool                                     | Method |
| ---------------------------------------- | ------ |
| `get-intune-conditional-access-settings` | GET    |
| `list-mtd-connectors`                    | GET    |
| `list-ios-update-statuses`               | GET    |

### Device categories (1)

| Tool                     | Method |
| ------------------------ | ------ |
| `list-device-categories` | GET    |

### Access reviews (5)

| Tool                             | Method |
| -------------------------------- | ------ |
| `list-access-review-definitions` | GET    |
| `get-access-review-definition`   | GET    |
| `list-access-review-instances`   | GET    |
| `get-access-review-instance`     | GET    |
| `list-access-review-decisions`   | GET    |

### Entitlement management (7)

| Tool                                  | Method |
| ------------------------------------- | ------ |
| `list-access-packages`                | GET    |
| `get-access-package`                  | GET    |
| `list-access-package-assignments`     | GET    |
| `list-access-package-requests`        | GET    |
| `list-access-package-catalogs`        | GET    |
| `list-connected-organizations`        | GET    |
| `get-entitlement-management-settings` | GET    |

### Lifecycle workflows (3)

| Tool                              | Method |
| --------------------------------- | ------ |
| `list-lifecycle-workflows`        | GET    |
| `get-lifecycle-workflow`          | GET    |
| `list-lifecycle-task-definitions` | GET    |

### PIM for Groups (2)

| Tool                                   | Method |
| -------------------------------------- | ------ |
| `list-pim-group-assignment-schedules`  | GET    |
| `list-pim-group-eligibility-schedules` | GET    |

### Terms of use (3)

| Tool                            | Method |
| ------------------------------- | ------ |
| `list-terms-of-use-agreements`  | GET    |
| `get-terms-of-use-agreement`    | GET    |
| `list-terms-of-use-acceptances` | GET    |

### App consent requests (3)

| Tool                         | Method |
| ---------------------------- | ------ |
| `list-app-consent-requests`  | GET    |
| `get-app-consent-request`    | GET    |
| `list-user-consent-requests` | GET    |

### Incident response (11) -- requires `--allow-writes`

| Tool                                     | Method | Risk     |
| ---------------------------------------- | ------ | -------- |
| `disable-user-account`                   | PATCH  | critical |
| `revoke-user-sessions`                   | POST   | high     |
| `add-security-alert-comment`             | POST   | low      |
| `update-device`                          | PATCH  | high     |
| `confirm-compromised-users`              | POST   | high     |
| `dismiss-risky-users`                    | POST   | high     |
| `delete-user-phone-auth-method`          | DELETE | high     |
| `confirm-compromised-service-principals` | POST   | high     |
| `dismiss-risky-service-principals`       | POST   | high     |
| `confirm-safe-users`                     | POST   | high     |
| `run-hunting-query`                      | POST   | low      |

### Intune device remote actions (16) -- requires `--allow-writes`

| Tool                            | Method | Risk     |
| ------------------------------- | ------ | -------- |
| `wipe-managed-device`           | POST   | critical |
| `retire-managed-device`         | POST   | high     |
| `sync-managed-device`           | POST   | low      |
| `reboot-managed-device`         | POST   | high     |
| `remote-lock-device`            | POST   | medium   |
| `reset-device-passcode`         | POST   | high     |
| `shutdown-managed-device`       | POST   | high     |
| `disable-lost-mode`             | POST   | low      |
| `locate-managed-device`         | POST   | low      |
| `bypass-activation-lock`        | POST   | high     |
| `trigger-defender-scan`         | POST   | low      |
| `update-defender-signatures`    | POST   | low      |
| `clean-windows-device`          | POST   | critical |
| `logout-shared-apple-user`      | POST   | medium   |
| `delete-shared-apple-user`      | POST   | high     |
| `update-windows-device-account` | POST   | medium   |

### Conditional Access CRUD (8) -- requires `--allow-writes`

| Tool                                | Method | Risk     |
| ----------------------------------- | ------ | -------- |
| `list-conditional-access-templates` | GET    |          |
| `get-conditional-access-policy`     | GET    |          |
| `create-conditional-access-policy`  | POST   | high     |
| `update-conditional-access-policy`  | PATCH  | high     |
| `delete-conditional-access-policy`  | DELETE | critical |
| `create-named-location`             | POST   | medium   |
| `update-named-location`             | PATCH  | medium   |
| `delete-named-location`             | DELETE | high     |

### Intune policies CRUD (6) -- requires `--allow-writes`

| Tool                          | Method | Risk   |
| ----------------------------- | ------ | ------ |
| `create-compliance-policy`    | POST   | medium |
| `update-compliance-policy`    | PATCH  | medium |
| `delete-compliance-policy`    | DELETE | high   |
| `create-device-configuration` | POST   | medium |
| `update-device-configuration` | PATCH  | medium |
| `delete-device-configuration` | DELETE | high   |

### eDiscovery (1)

| Tool                    | Method | Risk |
| ----------------------- | ------ | ---- |
| `list-ediscovery-cases` | GET    |      |

### Teams call records (11)

| Tool                            | Method |
| ------------------------------- | ------ |
| `list-call-records`             | GET    |
| `get-call-record`               | GET    |
| `list-call-record-sessions`     | GET    |
| `get-call-record-session`       | GET    |
| `list-call-session-segments`    | GET    |
| `get-call-session-segment`      | GET    |
| `list-call-record-participants` | GET    |
| `get-call-record-participant`   | GET    |
| `get-call-record-organizer`     | GET    |
| `get-pstn-calls`                | GET    |
| `get-direct-routing-calls`      | GET    |

### Cloud PC / Windows 365 (10)

| Tool                                    | Method | Risk   |
| --------------------------------------- | ------ | ------ |
| `list-cloud-pcs`                        | GET    |        |
| `list-cloud-pc-provisioning-policies`   | GET    |        |
| `list-cloud-pc-device-images`           | GET    |        |
| `list-cloud-pc-gallery-images`          | GET    |        |
| `list-cloud-pc-on-premises-connections` | GET    |        |
| `list-cloud-pc-user-settings`           | GET    |        |
| `list-cloud-pc-audit-events`            | GET    |        |
| `create-cloud-pc-provisioning-policy`   | POST   | medium |
| `update-cloud-pc-provisioning-policy`   | PATCH  | medium |
| `delete-cloud-pc-provisioning-policy`   | DELETE | high   |

### Universal Print (6)

| Tool                          | Method | Risk |
| ----------------------------- | ------ | ---- |
| `list-printers`               | GET    |      |
| `list-print-shares`           | GET    |      |
| `list-print-connectors`       | GET    |      |
| `list-print-services`         | GET    |      |
| `list-print-operations`       | GET    |      |
| `list-print-task-definitions` | GET    |      |

### Information Protection & Sensitivity Labels (7)

| Tool                              | Method |
| --------------------------------- | ------ |
| `list-bitlocker-recovery-keys`    | GET    |
| `list-threat-assessment-requests` | GET    |
| `list-sensitivity-labels`         | GET    |
| `get-sensitivity-label`           | GET    |
| `list-sensitivity-sublabels`      | GET    |
| `get-sensitivity-label-rights`    | GET    |
| `get-protection-scopes`           | GET    |

### SharePoint administration (25)

| Tool                      | Method | Risk   |
| ------------------------- | ------ | ------ |
| `get-sharepoint-settings` | GET    |        |
| `list-sharepoint-sites`   | GET    |        |
| `get-sharepoint-site`     | GET    |        |
| `update-sharepoint-site`  | PATCH  | medium |
| `list-site-drives`        | GET    |        |
| `get-site-default-drive`  | GET    |        |
| `list-site-lists`         | GET    |        |
| `get-site-list`           | GET    |        |
| `create-site-list`        | POST   | low    |
| `update-site-list`        | PATCH  | low    |
| `delete-site-list`        | DELETE | high   |
| `list-site-list-items`    | GET    |        |
| `create-site-list-item`   | POST   | low    |
| `update-site-list-item`   | PATCH  | low    |
| `delete-site-list-item`   | DELETE | medium |
| `list-site-list-columns`  | GET    |        |
| `list-site-columns`       | GET    |        |
| `list-site-content-types` | GET    |        |
| `list-site-permissions`   | GET    |        |
| `get-site-permission`     | GET    |        |
| `create-site-permission`  | POST   | medium |
| `update-site-permission`  | PATCH  | medium |
| `delete-site-permission`  | DELETE | high   |
| `get-site-analytics`      | GET    |        |
| `list-site-subsites`      | GET    |        |

### Records Management (6)

| Tool                         | Method | Risk |
| ---------------------------- | ------ | ---- |
| `list-retention-labels`      | GET    |      |
| `list-file-plan-authorities` | GET    |      |
| `list-file-plan-categories`  | GET    |      |
| `list-file-plan-citations`   | GET    |      |
| `list-file-plan-departments` | GET    |      |
| `list-file-plan-references`  | GET    |      |

### Teams administration (30)

| Tool                             | Method | Risk     |
| -------------------------------- | ------ | -------- |
| `list-teams`                     | GET    |          |
| `create-team`                    | POST   | medium   |
| `get-team`                       | GET    |          |
| `update-team`                    | PATCH  | medium   |
| `delete-team`                    | DELETE | critical |
| `list-team-admin-channels`       | GET    |          |
| `create-team-admin-channel`      | POST   | low      |
| `get-team-admin-channel`         | GET    |          |
| `delete-team-admin-channel`      | DELETE | high     |
| `list-team-admin-members`        | GET    |          |
| `add-team-admin-members`         | POST   | medium   |
| `remove-team-admin-members`      | POST   | medium   |
| `get-team-admin-member`          | GET    |          |
| `list-team-installed-apps`       | GET    |          |
| `archive-team`                   | POST   | medium   |
| `unarchive-team`                 | POST   | low      |
| `clone-team`                     | POST   | medium   |
| `list-team-operations`           | GET    |          |
| `list-team-permission-grants`    | GET    |          |
| `get-teams-app-settings`         | GET    |          |
| `update-teams-app-settings`      | PATCH  | high     |
| `list-deleted-teams`             | GET    |          |
| `list-teams-catalog-apps`        | GET    |          |
| `get-teams-catalog-app`          | GET    |          |
| `list-teams-app-definitions`     | GET    |          |
| `get-teams-admin-settings`       | GET    |          |
| `list-teams-user-configurations` | GET    |          |
| `get-teams-admin-policy`         | GET    |          |
| `list-teams-policy-assignments`  | GET    |          |
| `list-teams-phone-assignments`   | GET    |          |

### Intune reports (18) -- requires `--allow-writes` (POST endpoints)

| Tool                                             | Method | Risk |
| ------------------------------------------------ | ------ | ---- |
| `intune-device-noncompliance-report`             | POST   | low  |
| `intune-compliance-policy-noncompliance-report`  | POST   | low  |
| `intune-compliance-policy-noncompliance-summary` | POST   | low  |
| `intune-compliance-setting-noncompliance-report` | POST   | low  |
| `intune-config-policy-noncompliance-report`      | POST   | low  |
| `intune-config-policy-noncompliance-summary`     | POST   | low  |
| `intune-config-setting-noncompliance-report`     | POST   | low  |
| `intune-devices-without-compliance-report`       | POST   | low  |
| `intune-noncompliant-devices-settings-report`    | POST   | low  |
| `intune-policy-noncompliance-report`             | POST   | low  |
| `intune-policy-noncompliance-summary`            | POST   | low  |
| `intune-policy-noncompliance-metadata`           | POST   | low  |
| `intune-setting-noncompliance-report`            | POST   | low  |
| `intune-report-filters`                          | POST   | low  |
| `intune-historical-report`                       | POST   | low  |
| `intune-cached-report`                           | POST   | low  |
| `list-intune-report-export-jobs`                 | GET    |      |
| `intune-device-app-install-status-report`        | POST   | low  |

### Intune partners & infrastructure (10)

| Tool                                  | Method | Risk |
| ------------------------------------- | ------ | ---- |
| `list-compliance-management-partners` | GET    |      |
| `list-device-management-partners`     | GET    |      |
| `list-exchange-connectors`            | GET    |      |
| `list-remote-assistance-partners`     | GET    |      |
| `list-notification-message-templates` | GET    |      |
| `list-intune-resource-operations`     | GET    |      |
| `list-imported-autopilot-devices`     | GET    |      |
| `list-windows-malware-info`           | GET    |      |
| `list-intune-mobile-apps`             | GET    |      |
| `list-intune-app-categories`          | GET    |      |

### Intune app management (11)

| Tool                               | Method | Risk |
| ---------------------------------- | ------ | ---- |
| `list-intune-app-configurations`   | GET    |      |
| `list-managed-app-policies`        | GET    |      |
| `list-managed-app-registrations`   | GET    |      |
| `list-managed-app-statuses`        | GET    |      |
| `list-android-app-protections`     | GET    |      |
| `list-ios-app-protections`         | GET    |      |
| `list-default-app-protections`     | GET    |      |
| `list-targeted-app-configurations` | GET    |      |
| `list-mdm-wip-policies`            | GET    |      |
| `list-mam-wip-policies`            | GET    |      |
| `list-vpp-tokens`                  | GET    |      |

### Advanced policies (15)

| Tool                                      | Method | Risk |
| ----------------------------------------- | ------ | ---- |
| `list-activity-timeout-policies`          | GET    |      |
| `get-authorization-policy`                | GET    |      |
| `get-auth-flows-policy`                   | GET    |      |
| `list-claims-mapping-policies`            | GET    |      |
| `list-conditional-access-policies-v2`     | GET    |      |
| `get-default-app-management-policy`       | GET    |      |
| `get-device-registration-policy`          | GET    |      |
| `list-feature-rollout-policies`           | GET    |      |
| `list-home-realm-discovery-policies`      | GET    |      |
| `list-permission-grant-policies`          | GET    |      |
| `list-role-management-policies`           | GET    |      |
| `list-role-management-policy-assignments` | GET    |      |
| `list-token-issuance-policies`            | GET    |      |
| `list-token-lifetime-policies`            | GET    |      |
| `get-cross-tenant-default-policy`         | GET    |      |

### Identity Governance+ (11)

| Tool                                     | Method | Risk |
| ---------------------------------------- | ------ | ---- |
| `list-entitlement-assignment-policies`   | GET    |      |
| `list-entitlement-resources`             | GET    |      |
| `list-entitlement-resource-environments` | GET    |      |
| `list-lifecycle-workflow-templates`      | GET    |      |
| `get-lifecycle-workflow-settings`        | GET    |      |
| `list-lifecycle-custom-task-extensions`  | GET    |      |
| `list-deleted-lifecycle-workflows`       | GET    |      |
| `list-pim-group-assignment-requests`     | GET    |      |
| `list-pim-group-assignment-instances`    | GET    |      |
| `list-pim-group-eligibility-requests`    | GET    |      |
| `list-pim-group-eligibility-instances`   | GET    |      |

### PIM role management (6)

| Tool                                  | Method | Risk |
| ------------------------------------- | ------ | ---- |
| `list-access-review-history`          | GET    |      |
| `list-pim-role-assignment-requests`   | GET    |      |
| `list-pim-role-assignment-schedules`  | GET    |      |
| `list-pim-role-eligibility-requests`  | GET    |      |
| `list-pim-role-eligibility-schedules` | GET    |      |
| `list-role-resource-namespaces`       | GET    |      |

### Identity Protection+ (2)

| Tool                                     | Method | Risk |
| ---------------------------------------- | ------ | ---- |
| `list-service-principal-risk-detections` | GET    |      |

### Security advanced (14)

| Tool                                     | Method | Risk |
| ---------------------------------------- | ------ | ---- |
| `list-identity-health-issues`            | GET    |      |
| `list-identity-sensors`                  | GET    |      |
| `get-identity-security-settings`         | GET    |      |
| `list-retention-events`                  | GET    |      |
| `list-retention-event-types`             | GET    |      |
| `list-subject-rights-requests`           | GET    |      |
| `list-simulation-automations`            | GET    |      |
| `list-simulation-trainings`              | GET    |      |
| `list-simulation-payloads`               | GET    |      |
| `list-simulation-end-user-notifications` | GET    |      |
| `list-simulation-landing-pages`          | GET    |      |
| `list-simulation-login-pages`            | GET    |      |

### Threat intelligence+ (7)

| Tool                              | Method | Risk |
| --------------------------------- | ------ | ---- |
| `list-passive-dns-records`        | GET    |      |
| `list-ssl-certificates`           | GET    |      |
| `list-threat-intel-subdomains`    | GET    |      |
| `list-threat-intel-host-ports`    | GET    |      |
| `list-threat-intel-host-trackers` | GET    |      |
| `list-threat-intel-host-cookies`  | GET    |      |
| `list-threat-intel-host-pairs`    | GET    |      |

### Reports+ (5)

| Tool                                  | Method | Risk |
| ------------------------------------- | ------ | ---- |
| `list-user-registration-details`      | GET    |      |
| `list-daily-print-usage-by-printer`   | GET    |      |
| `list-daily-print-usage-by-user`      | GET    |      |
| `list-monthly-print-usage-by-printer` | GET    |      |
| `list-monthly-print-usage-by-user`    | GET    |      |

### Copilot admin (2)

| Tool                         | Method | Risk |
| ---------------------------- | ------ | ---- |
| `get-copilot-admin-settings` | GET    |      |
| `get-copilot-limited-mode`   | GET    |      |

### Directory+ (5)

| Tool                              | Method | Risk |
| --------------------------------- | ------ | ---- |
| `list-attribute-sets`             | GET    |      |
| `list-custom-security-attributes` | GET    |      |
| `list-device-local-credentials`   | GET    |      |
| `list-federation-configurations`  | GET    |      |
| `list-on-premises-sync`           | GET    |      |

### Application credentials & owners CRUD (11) -- requires `--allow-writes`

| Tool                                 | Method | Risk   |
| ------------------------------------ | ------ | ------ |
| `create-application`                 | POST   | high   |
| `add-application-password`           | POST   | high   |
| `remove-application-password`        | POST   | high   |
| `add-application-key`                | POST   | high   |
| `remove-application-key`             | POST   | high   |
| `add-application-owner`              | POST   | high   |
| `remove-application-owner`           | DELETE | high   |
| `create-app-federated-credential`    | POST   | high   |
| `update-app-federated-credential`    | PATCH  | high   |
| `delete-app-federated-credential`    | DELETE | high   |
| `set-application-verified-publisher` | POST   | medium |

### Service Principals CRUD & credentials (10) -- requires `--allow-writes`

| Tool                               | Method | Risk     |
| ---------------------------------- | ------ | -------- |
| `create-service-principal`         | POST   | high     |
| `delete-service-principal`         | DELETE | critical |
| `add-sp-password`                  | POST   | high     |
| `remove-sp-password`               | POST   | high     |
| `add-sp-key`                       | POST   | high     |
| `remove-sp-key`                    | POST   | high     |
| `add-sp-token-signing-certificate` | POST   | high     |
| `add-sp-owner`                     | POST   | high     |
| `remove-sp-owner`                  | DELETE | high     |
| `create-sp-app-role-assignment`    | POST   | high     |

### PIM activation & requests (10) -- requires `--allow-writes`

| Tool                                       | Method | Risk     |
| ------------------------------------------ | ------ | -------- |
| `create-pim-role-assignment-request`       | POST   | critical |
| `cancel-pim-role-assignment-request`       | POST   | high     |
| `create-pim-role-eligibility-request`      | POST   | critical |
| `cancel-pim-role-eligibility-request`      | POST   | high     |
| `create-pim-group-assignment-request`      | POST   | high     |
| `cancel-pim-group-assignment-request`      | POST   | medium   |
| `create-pim-group-eligibility-request`     | POST   | high     |
| `cancel-pim-group-eligibility-request`     | POST   | medium   |
| `create-role-management-policy-assignment` | POST   | high     |
| `update-role-management-policy`            | PATCH  | high     |

### Entitlement Management CRUD (12) -- requires `--allow-writes`

| Tool                                          | Method | Risk   |
| --------------------------------------------- | ------ | ------ |
| `create-access-package`                       | POST   | medium |
| `update-access-package`                       | PATCH  | medium |
| `delete-access-package`                       | DELETE | high   |
| `create-access-package-catalog`               | POST   | medium |
| `update-access-package-catalog`               | PATCH  | medium |
| `delete-access-package-catalog`               | DELETE | high   |
| `create-access-package-assignment-policy`     | POST   | medium |
| `update-access-package-assignment-policy`     | PUT    | medium |
| `delete-access-package-assignment-policy`     | DELETE | high   |
| `create-access-package-assignment-request`    | POST   | medium |
| `reprocess-access-package-assignment-request` | POST   | low    |
| `cancel-access-package-assignment-request`    | POST   | medium |

### Lifecycle Workflows CRUD & execution (8) -- requires `--allow-writes`

| Tool                                     | Method | Risk   |
| ---------------------------------------- | ------ | ------ |
| `create-lifecycle-workflow`              | POST   | medium |
| `update-lifecycle-workflow`              | PATCH  | medium |
| `delete-lifecycle-workflow`              | DELETE | high   |
| `activate-lifecycle-workflow`            | POST   | high   |
| `restore-lifecycle-workflow`             | POST   | medium |
| `create-lifecycle-custom-task-extension` | POST   | medium |
| `update-lifecycle-custom-task-extension` | PATCH  | medium |
| `delete-lifecycle-custom-task-extension` | DELETE | high   |

### Access Reviews CRUD & actions (8) -- requires `--allow-writes`

| Tool                                   | Method | Risk   |
| -------------------------------------- | ------ | ------ |
| `create-access-review-definition`      | POST   | medium |
| `update-access-review-definition`      | PUT    | medium |
| `delete-access-review-definition`      | DELETE | high   |
| `stop-access-review-instance`          | POST   | high   |
| `send-reminder-access-review`          | POST   | low    |
| `reset-access-review-decisions`        | POST   | high   |
| `apply-access-review-decisions`        | POST   | high   |
| `accept-access-review-recommendations` | POST   | medium |

### eDiscovery v2 (Purview) (12) -- writes require `--allow-writes`

| Tool                               | Method | Risk     |
| ---------------------------------- | ------ | -------- |
| `get-ediscovery-case`              | GET    |          |
| `create-ediscovery-case`           | POST   | medium   |
| `update-ediscovery-case`           | PATCH  | medium   |
| `delete-ediscovery-case`           | DELETE | critical |
| `close-ediscovery-case`            | POST   | medium   |
| `reopen-ediscovery-case`           | POST   | medium   |
| `list-ediscovery-custodians`       | GET    |          |
| `create-ediscovery-custodian`      | POST   | medium   |
| `apply-hold-ediscovery-custodian`  | POST   | high     |
| `remove-hold-ediscovery-custodian` | POST   | high     |
| `list-ediscovery-searches`         | GET    |          |
| `create-ediscovery-search`         | POST   | medium   |

## Azure AD permissions

### Read-only (default)

```
AccessReview.Read.All
AdministrativeUnit.Read.All
Agreement.Read.All
APIConnectors.Read.All
AppCatalog.Read.All
Application.Read.All
AppRoleAssignment.Read.All
AttackSimulation.Read.All
AuditLog.Read.All
BitlockerKey.Read.All
CallRecords.Read.All
Channel.ReadBasic.All
CloudPC.Read.All
ConsentRequest.Read.All
CopilotSettings-Internal.ReadWrite.All
CustomAuthenticationExtension.Read.All
CustomSecAttributeDefinition.Read.All
Device.Read.All
DeviceLocalCredential.Read.All
DeviceManagementApps.Read.All
DeviceManagementConfiguration.Read.All
DeviceManagementManagedDevices.Read.All
DeviceManagementRBAC.Read.All
DeviceManagementServiceConfig.Read.All
Directory.Read.All
Domain.Read.All
eDiscovery.Read.All
EntitlementManagement.Read.All
Exchange.ManageAsApp
Group.Read.All
GroupMember.Read.All
IdentityProvider.Read.All
IdentityRiskEvent.Read.All
IdentityRiskyServicePrincipal.Read.All
IdentityRiskyUser.Read.All
IdentityUserFlow.Read.All
InformationProtectionPolicy.Read.All
LifecycleWorkflows.Read.All
MailboxSettings.Read
OnPremDirectorySynchronization.Read.All
Organization.Read.All
Policy.Read.All
Printer.Read.All
PrintConnector.Read.All
PrintJob.Read.All
PrivilegedAccess.Read.AzureADGroup
RecordsManagement.Read.All
Reports.Read.All
RoleAssignmentSchedule.Read.Directory
RoleEligibilitySchedule.Read.Directory
RoleManagement.Read.Directory
RoleManagementPolicy.Read.Directory
SecurityAlert.Read.All
SecurityEvents.Read.All
SecurityIdentitiesHealth.Read.All
SecurityIncident.Read.All
ServiceHealth.Read.All
ServiceMessage.Read.All
SharePointTenantSettings.Read.All
Sites.Read.All
Sites.FullControl.All
SubjectRightsRequest.Read.All
Team.ReadBasic.All
TeamMember.Read.All
TeamsAppInstallation.ReadForTeam.All
TeamworkAppSettings.Read.All
TeamworkDevice.Read.All
ThreatAssessment.Read.All
ThreatHunting.Read.All
ThreatIntelligence.Read.All
User.Invite.All
User.Read.All
UserAuthenticationMethod.Read.All
```

### Write (incident response, device actions, CA policies, Teams, SharePoint, identity management)

```
AccessReview.ReadWrite.All
AdministrativeUnit.ReadWrite.All
Application.ReadWrite.All
Application.ReadWrite.OwnedBy
AppRoleAssignment.ReadWrite.All
AttackSimulation.ReadWrite.All
Channel.Create
Channel.Delete.All
CloudPC.ReadWrite.All
Device.ReadWrite.All
DeviceManagementConfiguration.ReadWrite.All
DeviceManagementManagedDevices.PrivilegedOperations.All
DeviceManagementManagedDevices.ReadWrite.All
DeviceManagementServiceConfig.ReadWrite.All
Directory.AccessAsUser.All
Domain.ReadWrite.All
eDiscovery.ReadWrite.All
EntitlementManagement.ReadWrite.All
Group.ReadWrite.All
GroupMember.ReadWrite.All
IdentityRiskyServicePrincipal.ReadWrite.All
IdentityRiskyUser.ReadWrite.All
LifecycleWorkflows.ReadWrite.All
Policy.ReadWrite.AuthenticationMethod
Policy.ReadWrite.ConditionalAccess
PrivilegedAccess.ReadWrite.AzureADGroup
RoleAssignmentSchedule.ReadWrite.Directory
RoleEligibilitySchedule.ReadWrite.Directory
RoleManagement.ReadWrite.Directory
RoleManagementPolicy.ReadWrite.Directory
SecurityAlert.ReadWrite.All
SecurityIncident.ReadWrite.All
Sites.ReadWrite.All
Team.Create
Team.ReadWrite.All
TeamMember.ReadWrite.All
TeamworkAppSettings.ReadWrite.All
User.ReadWrite.All
UserAuthenticationMethod.ReadWrite.All
```

## Remote HTTP deployment

### Local HTTP mode

```bash
node dist/index.js \
  --transport http \
  --port 8080 \
  --allowed-clients "app-id-1,app-id-2"
```

The `--allowed-clients` flag is **mandatory** in HTTP mode. It validates incoming bearer tokens against Microsoft's JWKS endpoint (signature verification, audience, tenant, and client ID checks).

### Docker

```bash
docker build -t ms365-admin-mcp .
docker run -p 8080:8080 \
  -e MS365_ADMIN_MCP_CLIENT_ID=... \
  -e MS365_ADMIN_MCP_CLIENT_SECRET=... \
  -e MS365_ADMIN_MCP_TENANT_ID=... \
  ms365-admin-mcp --allowed-clients "your-app-id"
```

### Azure Container Apps

A Bicep template is provided in `infra/main.bicep`. It deploys:

- User-Assigned Managed Identity (UAMI)
- Key Vault (RBAC, purge protection, 90-day soft-delete)
- Log Analytics workspace + Application Insights
- Container App Environment
- Container App using the UAMI, with `MS365_ADMIN_MCP_KEYVAULT_URL` wired to the vault

```bash
MY_OID=$(az ad signed-in-user show --query id -o tsv)

az deployment group create \
  --resource-group rg-mcp-admin \
  --template-file infra/main.bicep \
  --parameters baseName=ms365mcpprod \
               containerImage=your-acr.azurecr.io/ms365-admin-mcp:latest \
               kvAdminObjectIds="['$MY_OID']"
```

Seed the vault with `ms365-admin-mcp-{client-id,tenant-id,client-secret}` after deploy — see [docs/HTTP_DEPLOYMENT.md](docs/HTTP_DEPLOYMENT.md#seed-key-vault-secrets).

## Development

```bash
npm run dev              # Run with tsx (hot reload)
npm run generate         # Download OpenAPI spec + generate client
npm run build            # Build with tsup
npm run test             # Run vitest
npm run lint             # ESLint
npm run format           # Prettier
npm run verify           # Full pipeline (generate + lint + format + build + test)
npm run inspector        # MCP Inspector for interactive testing
```

### Adding a new tool

1. Add the endpoint entry in `src/endpoints.json`
2. Run `npm run generate` to regenerate the client
3. The tool is automatically registered at startup by `registerGraphTools()`
4. Run `npm run verify` to validate

## Security

- **Read-only by default** -- mutations require `--allow-writes`
- **Risk levels** on write tools (critical/high/medium/low) with LLM-visible warnings
- **JWT signature verification** via Microsoft JWKS (RS256) in HTTP mode
- **Mandatory authentication** in HTTP mode (`--allowed-clients` required)
- **Rate limiting** (100 req/min) on the MCP endpoint
- **Security headers** (nosniff, DENY, no-store, CSP)
- **Non-root Docker user**
- **Sensitive data redacted** from logs

## Acknowledgments

This project would not exist without [Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server). Their work served as the foundation and inspiration for this server — in particular:

- The **endpoint-driven architecture** (`endpoints.json` + auto-registration via `graph-tools.ts`)
- The **OpenAPI-based code generation** pipeline (`npm run generate` → trimmed Graph spec + Zodios client)
- The **CLI ergonomics** (presets, `--list-tools`, `--list-permissions`, `--verify-login`, MCP Inspector integration)
- The **read-only-by-default + `--allow-writes`** safety model

This server diverges from Softeria's by targeting **application permissions** (client credentials via MSAL `ConfidentialClientApplication`) rather than delegated permissions, and by adding admin-specific capabilities — risk classification on write tools, JWT validation via Microsoft JWKS for HTTP mode, Azure Key Vault integration, and incident-response tooling.

Sincere thanks to the Softeria team and contributors for making their work available under an open license, and for setting a high bar for MCP server design in the Microsoft 365 ecosystem.

## License

MIT — see [LICENSE](LICENSE).
