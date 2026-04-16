# ms-365-admin-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for Microsoft 365 administration via Graph API **application permissions** (client credentials).

Complementary to [Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server) which uses delegated permissions. This server is designed for admin operations: security monitoring, identity audits, incident response, and service health.

## Features

- **199 tools** covering security, audit, identity, app credentials, guest users, Exchange, Intune, governance, compliance, threat intelligence, reports, incident response, eDiscovery, Cloud PC, call records, Universal Print, information protection, SharePoint admin, and records management
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

## Available tools (199)

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

| Tool                            | Method |
| ------------------------------- | ------ |
| `list-directory-roles`          | GET    |
| `list-role-members`             | GET    |
| `list-role-assignments`         | GET    |
| `list-role-definitions`         | GET    |
| `list-pim-eligible-assignments` | GET    |
| `list-pim-active-assignments`   | GET    |

### Administrative units (3)

| Tool                               | Method |
| ---------------------------------- | ------ |
| `list-administrative-units`        | GET    |
| `get-administrative-unit`          | GET    |
| `list-administrative-unit-members` | GET    |

### Conditional access (3)

| Tool                               | Method |
| ---------------------------------- | ------ |
| `list-conditional-access-policies` | GET    |
| `get-conditional-access-policy`    | GET    |
| `list-named-locations`             | GET    |

### Applications & app roles (5)

| Tool                             | Method |
| -------------------------------- | ------ |
| `list-applications`              | GET    |
| `list-service-principals`        | GET    |
| `list-oauth2-grants`             | GET    |
| `list-user-app-role-assignments` | GET    |
| `list-sp-app-role-assignments`   | GET    |

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

| Tool                             | Method |
| -------------------------------- | ------ |
| `get-auth-methods-policy`        | GET    |
| `list-auth-method-configs`       | GET    |
| `get-auth-method-config`         | GET    |
| `get-security-defaults`          | GET    |
| `get-admin-consent-policy`       | GET    |
| `list-auth-strength-policies`    | GET    |
| `get-cross-tenant-access-policy` | GET    |
| `list-cross-tenant-partners`     | GET    |

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

### Exchange mailboxes (2)

| Tool                      | Method |
| ------------------------- | ------ |
| `list-exchange-mailboxes` | GET    |
| `get-exchange-mailbox`    | GET    |

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

### Managed devices (5)

| Tool                               | Method |
| ---------------------------------- | ------ |
| `list-managed-devices`             | GET    |
| `get-managed-device`               | GET    |
| `list-device-compliance-states`    | GET    |
| `list-device-configuration-states` | GET    |
| `get-managed-device-overview`      | GET    |

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

### Enrollment & Autopilot (4)

| Tool                             | Method |
| -------------------------------- | ------ |
| `list-enrollment-configurations` | GET    |
| `get-enrollment-configuration`   | GET    |
| `list-autopilot-devices`         | GET    |
| `get-autopilot-device`           | GET    |

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

### Incident response (7) -- requires `--allow-writes`

| Tool                            | Method | Risk     |
| ------------------------------- | ------ | -------- |
| `disable-user-account`          | PATCH  | critical |
| `revoke-user-sessions`          | POST   | high     |
| `add-security-alert-comment`    | POST   | low      |
| `update-device`                 | PATCH  | high     |
| `confirm-compromised-users`     | POST   | high     |
| `dismiss-risky-users`           | POST   | high     |
| `delete-user-phone-auth-method` | DELETE | high     |

### eDiscovery (1)

| Tool                    | Method | Risk |
| ----------------------- | ------ | ---- |
| `list-ediscovery-cases` | GET    |      |

### Teams call records (1)

| Tool                | Method | Risk |
| ------------------- | ------ | ---- |
| `list-call-records` | GET    |      |

### Cloud PC / Windows 365 (7)

| Tool                                    | Method | Risk |
| --------------------------------------- | ------ | ---- |
| `list-cloud-pcs`                        | GET    |      |
| `list-cloud-pc-provisioning-policies`   | GET    |      |
| `list-cloud-pc-device-images`           | GET    |      |
| `list-cloud-pc-gallery-images`          | GET    |      |
| `list-cloud-pc-on-premises-connections` | GET    |      |
| `list-cloud-pc-user-settings`           | GET    |      |
| `list-cloud-pc-audit-events`            | GET    |      |

### Universal Print (6)

| Tool                          | Method | Risk |
| ----------------------------- | ------ | ---- |
| `list-printers`               | GET    |      |
| `list-print-shares`           | GET    |      |
| `list-print-connectors`       | GET    |      |
| `list-print-services`         | GET    |      |
| `list-print-operations`       | GET    |      |
| `list-print-task-definitions` | GET    |      |

### Information Protection (2)

| Tool                              | Method | Risk |
| --------------------------------- | ------ | ---- |
| `list-bitlocker-recovery-keys`    | GET    |      |
| `list-threat-assessment-requests` | GET    |      |

### SharePoint admin (1)

| Tool                      | Method | Risk |
| ------------------------- | ------ | ---- |
| `get-sharepoint-settings` | GET    |      |

### Records Management (6)

| Tool                         | Method | Risk |
| ---------------------------- | ------ | ---- |
| `list-retention-labels`      | GET    |      |
| `list-file-plan-authorities` | GET    |      |
| `list-file-plan-categories`  | GET    |      |
| `list-file-plan-citations`   | GET    |      |
| `list-file-plan-departments` | GET    |      |
| `list-file-plan-references`  | GET    |      |

## Azure AD permissions

### Read-only (default)

```
AccessReview.Read.All
AdministrativeUnit.Read.All
Agreement.Read.All
Application.Read.All
AppRoleAssignment.Read.All
AttackSimulation.Read.All
AuditLog.Read.All
ConsentRequest.Read.All
CustomAuthenticationExtension.Read.All
Device.Read.All
DeviceManagementApps.Read.All
DeviceManagementConfiguration.Read.All
DeviceManagementManagedDevices.Read.All
DeviceManagementRBAC.Read.All
DeviceManagementServiceConfig.Read.All
Directory.Read.All
Domain.Read.All
EntitlementManagement.Read.All
Exchange.ManageAsApp
Group.Read.All
GroupMember.Read.All
APIConnectors.Read.All
IdentityProvider.Read.All
IdentityRiskEvent.Read.All
IdentityUserFlow.Read.All
IdentityRiskyServicePrincipal.Read.All
IdentityRiskyUser.Read.All
LifecycleWorkflows.Read.All
Organization.Read.All
Policy.Read.All
MailboxSettings.Read
PrivilegedAccess.Read.AzureADGroup
Reports.Read.All
RoleAssignmentSchedule.Read.Directory
RoleEligibilitySchedule.Read.Directory
RoleManagement.Read.Directory
BitlockerKey.Read.All
CallRecords.Read.All
CloudPC.Read.All
eDiscovery.Read.All
Printer.Read.All
PrintConnector.Read.All
PrintJob.Read.All
RecordsManagement.Read.All
SecurityAlert.Read.All
SecurityEvents.Read.All
SecurityIncident.Read.All
SharePointTenantSettings.Read.All
ThreatAssessment.Read.All
ThreatIntelligence.Read.All
ServiceHealth.Read.All
ServiceMessage.Read.All
User.Invite.All
User.Read.All
UserAuthenticationMethod.Read.All
```

### Write (incident response + invitations)

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
