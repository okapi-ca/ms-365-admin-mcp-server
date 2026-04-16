# ms-365-admin-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for Microsoft 365 administration via Graph API **application permissions** (client credentials).

Complementary to [Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server) which uses delegated permissions. This server is designed for admin operations: security monitoring, identity audits, incident response, and service health.

## Features

- **82 tools** covering security, audit, identity, compliance, reports, and incident response
- **Application permissions** (client credentials) — no user interaction required
- **Read-only by default** — write operations require explicit `--allow-writes`
- **Risk classification** on write tools (low/medium/high/critical)
- **Presets** to filter tools by domain (security, audit, identity, etc.)
- **Two transports**: stdio (default) and HTTP (StreamableHTTP)
- **Multi-cloud**: Microsoft global and China (21Vianet)
- **Key Vault** support for secrets management

## Prerequisites

- Node.js >= 18
- An Azure AD app registration with **application permissions** (not delegated)
- A specific tenant ID (not "common")

## Installation

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

| Preset       | Description                                                    |
| ------------ | -------------------------------------------------------------- |
| `security`   | Security alerts, incidents, and attack simulations                          |
| `audit`      | Directory audits, sign-ins, provisioning logs, deleted items                |
| `health`     | Service health and Message Center                                           |
| `reports`    | Usage reports (Teams, Email, SharePoint, OneDrive, Mailbox, M365 Apps)      |
| `identity`   | Users, groups, roles, devices, PIM, conditional access, apps, domains       |
| `compliance` | Licenses, Secure Score, Identity Protection, risk detections, policies      |
| `response`   | Incident response write operations (disable, revoke, confirm, dismiss)      |
| `all`        | All available tools                                                         |

### Verify credentials

```bash
node dist/index.js --verify-login
```

## Available tools (82)

### Security (8)

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

### Users (5)

| Tool                     | Method |
| ------------------------ | ------ |
| `list-users`             | GET    |
| `get-user`               | GET    |
| `list-user-memberships`  | GET    |
| `list-user-auth-methods` | GET    |
| `list-user-devices`      | GET    |

### Devices (2)

| Tool           | Method |
| -------------- | ------ |
| `list-devices` | GET    |
| `get-device`   | GET    |

### Groups (4)

| Tool                 | Method |
| -------------------- | ------ |
| `list-groups`        | GET    |
| `get-group`          | GET    |
| `list-group-members` | GET    |
| `list-group-owners`  | GET    |

### Directory roles & PIM (6)

| Tool                           | Method |
| ------------------------------ | ------ |
| `list-directory-roles`         | GET    |
| `list-role-members`            | GET    |
| `list-role-assignments`        | GET    |
| `list-role-definitions`        | GET    |
| `list-pim-eligible-assignments`| GET    |
| `list-pim-active-assignments`  | GET    |

### Administrative units (3)

| Tool                                | Method |
| ----------------------------------- | ------ |
| `list-administrative-units`         | GET    |
| `get-administrative-unit`           | GET    |
| `list-administrative-unit-members`  | GET    |

### Conditional access (3)

| Tool                               | Method |
| ---------------------------------- | ------ |
| `list-conditional-access-policies` | GET    |
| `get-conditional-access-policy`    | GET    |
| `list-named-locations`             | GET    |

### Applications & app roles (5)

| Tool                            | Method |
| ------------------------------- | ------ |
| `list-applications`             | GET    |
| `list-service-principals`       | GET    |
| `list-oauth2-grants`            | GET    |
| `list-user-app-role-assignments`| GET    |
| `list-sp-app-role-assignments`  | GET    |

### Organization (2)

| Tool               | Method |
| ------------------ | ------ |
| `get-organization` | GET    |
| `list-domains`     | GET    |

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

### Security & access policies (8)

| Tool                              | Method |
| --------------------------------- | ------ |
| `get-auth-methods-policy`         | GET    |
| `list-auth-method-configs`        | GET    |
| `get-auth-method-config`          | GET    |
| `get-security-defaults`           | GET    |
| `get-admin-consent-policy`        | GET    |
| `list-auth-strength-policies`     | GET    |
| `get-cross-tenant-access-policy`  | GET    |
| `list-cross-tenant-partners`      | GET    |

### Incident response (7) -- requires `--allow-writes`

| Tool                             | Method | Risk     |
| -------------------------------- | ------ | -------- |
| `disable-user-account`           | PATCH  | critical |
| `revoke-user-sessions`           | POST   | high     |
| `add-security-alert-comment`     | POST   | low      |
| `update-device`                  | PATCH  | high     |
| `confirm-compromised-users`      | POST   | high     |
| `dismiss-risky-users`            | POST   | medium   |
| `delete-user-phone-auth-method`  | DELETE | high     |

## Azure AD permissions

### Read-only (default)

```
AdministrativeUnit.Read.All
Application.Read.All
AppRoleAssignment.ReadWrite.All
AttackSimulation.Read.All
AuditLog.Read.All
Device.Read.All
Directory.Read.All
Domain.Read.All
Group.Read.All
GroupMember.Read.All
IdentityRiskEvent.Read.All
IdentityRiskyServicePrincipal.Read.All
IdentityRiskyUser.Read.All
Organization.Read.All
Policy.Read.All
Reports.Read.All
RoleAssignmentSchedule.Read.Directory
RoleEligibilitySchedule.Read.Directory
RoleManagement.Read.Directory
SecurityAlert.Read.All
SecurityEvents.Read.All
SecurityIncident.Read.All
ServiceHealth.Read.All
ServiceMessage.Read.All
User.Read.All
UserAuthenticationMethod.Read.All
```

### Write (incident response)

```
Device.ReadWrite.All
IdentityRiskyUser.ReadWrite.All
SecurityAlert.ReadWrite.All
SecurityIncident.ReadWrite.All
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

A Bicep skeleton is provided in `infra/main.bicep`. It deploys:

- Log Analytics workspace
- Application Insights
- Container App Environment
- Container App with system-assigned managed identity

```bash
az deployment group create \
  --resource-group rg-mcp-admin \
  --template-file infra/main.bicep \
  --parameters containerImage=your-acr.azurecr.io/ms365-admin-mcp:latest \
               tenantId=your-tenant-id \
               clientId=your-client-id \
               clientSecret=your-client-secret
```

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

## License

MIT
