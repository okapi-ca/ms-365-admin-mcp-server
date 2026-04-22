# Azure Container Apps — Deployment Security Architecture

This document is the reference for deploying `ms-365-admin-mcp-server` to Azure Container Apps in a **production-grade, least-privilege** configuration. It exists because this server speaks Microsoft Graph with tenant-wide admin permissions — an insecure deployment can expose the entire Microsoft 365 tenant (mailboxes, devices, Entra roles, Conditional Access policies, BitLocker keys, audit logs).

Read this before running `az deployment group create` against a tenant you care about.

## Who should read this

- **Operators** deploying the server to their own Azure tenant (the `infra/main.bicep` template in this repo is the reference deployment)
- **Security reviewers** approving the deployment for production
- **Auditors** verifying the deployment matches the intended threat model

This is not a tutorial. For the operational how-to, see [HTTP_DEPLOYMENT.md](HTTP_DEPLOYMENT.md). For app registration steps, see [APP_REGISTRATION.md](APP_REGISTRATION.md). For tool-level risk ratings, see [RISK_MODEL.md](RISK_MODEL.md).

## Threat model

### Assets

| Asset                                                   | Sensitivity | Why it matters                                                                                                   |
| ------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| Entra app registration client secret                    | Critical    | Grants tenant-wide Graph access under application permissions or OBO confidential-client exchange                |
| User OAuth tokens (in transit + at rest in Azure Table) | High        | Allow impersonation of the authenticated user for the token lifetime                                             |
| Container App logs                                      | High        | May contain user UPNs, tool invocations, targets of admin operations (scrubbed at source but assume recoverable) |
| OAuth state / DCR registrations (Azure Table)           | Medium      | Enable session hijacking if tampered with during OAuth handshake                                                 |
| Admin oid allowlist (`--authorized-users`)              | Low/config  | Bypass = total access to the MCP server                                                                          |

### Adversary capabilities (in scope)

1. **External attacker on the public internet** — can reach any public endpoint, fuzz OAuth flows, attempt token forgery, look for misconfigured tenants
2. **Compromised low-privilege tenant user** — has a valid Entra token for `User.Read`, tries to authenticate to the MCP and escalate
3. **Malicious MCP client** — sends crafted tool arguments, prompt-injection payloads, replayed tokens
4. **Compromised operator workstation** — can rotate secrets, but cannot directly access the Key Vault from outside the authorized VPN/network

### Adversary capabilities (out of scope)

- Azure platform compromise (Microsoft's responsibility)
- Key Vault HSM extraction (covered by Azure's FIPS 140-2 controls)
- Compromise of an authenticated user's identity (e.g. stolen admin MFA-passed session — the server trusts the user's Entra token; upstream Conditional Access + MFA + session lifetime are the mitigations)

### Entry points

1. `/mcp` — MCP Streamable HTTP endpoint, requires valid Entra user token OR service-to-service app token
2. `/authorize`, `/token`, `/register` — OAuth 2.1 proxy endpoints (when `--oauth-mode`)
3. `/.well-known/oauth-authorization-server` — unauthenticated metadata endpoint
4. `/health` — unauthenticated liveness probe
5. Graph API → back from the server under the user's delegated identity (OBO) or the app's client credentials

## Recommended architecture

```
                  +-----------------------+
                  |   Corporate VPN user  |
                  |   (Claude Desktop)    |
                  +-----------+-----------+
                              |
                              | TLS 1.2+, Entra OAuth PKCE
                              v
    +------------------------------------------------------+
    |             Hub Virtual Network (operator)            |
    |                                                       |
    |   +------------------------------------------------+  |
    |   |  Infrastructure subnet                         |  |
    |   |  (delegated to Microsoft.App/environments)     |  |
    |   |  +------------------------------------------+  |  |
    |   |  |  Container Apps Environment (internal)   |  |  |
    |   |  |    workload-profiles SKU                 |  |  |
    |   |  |                                          |  |  |
    |   |  |  Container App (mcp-admin, UAMI)         |  |  |
    |   |  |    --oauth-mode --authorized-users ...   |  |  |
    |   |  +------------------------------------------+  |  |
    |   +------------------------------------------------+  |
    +-------------------------------------------------------+
                              |
                              | managed identity → Azure
                              v
    +------------------------------------------------------+
    |  Supporting resources (same RG as CAE, or shared)    |
    |   -> Key Vault (RBAC, purge protection)              |
    |   -> Storage Account Table (allowSharedKeyAccess=No) |
    |   -> Log Analytics workspace                         |
    +------------------------------------------------------+
                          |
                          | MSAL OBO / client_credentials
                          v
              +----------------------------+
              |   Microsoft Graph API      |
              |   (tenant admin endpoints) |
              +----------------------------+
```

The key property: **the MCP server is not reachable from the public internet**. The CAE is deployed with `vnetConfiguration.internal: true` into an infrastructure subnet on the operator's hub VNet. Every authenticated caller arrives via corporate VPN → hub VNet → CAE. Conditional Access on the user's delegated token enforces MFA, compliant device, and location policies against the user's real identity, not an opaque service principal.

## Required controls (MUST)

These are non-negotiable for any tenant where admin compromise is unacceptable. The `infra/main.bicep` template enforces all of them when `vnetIntegrated=true`.

| #   | Control                                                                                                                                    | How it's enforced in this repo                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **`--oauth-mode` with `--authorized-users` allowlist** — no anonymous tenant users can authenticate                                        | `oauthMode=true` + non-empty `authorizedUsers` parameter; server refuses to start otherwise (SEC-F01)                                                                                                     |
| R2  | **OBO delegated Graph calls** — admin actions logged under the user's UPN in the Unified Audit Log, not the app identity                   | Built-in since v0.5.0; activated by `--oauth-mode`                                                                                                                                                        |
| R3  | **CAE workload-profiles SKU with `vnetConfiguration.internal: true`** — no public ingress, clients reach the server only from the hub VNet | `vnetIntegrated=true` param + `workloadProfiles` array + `vnetConfiguration.{infrastructureSubnetId, internal: true}` on the CAE                                                                          |
| R4  | **Network access to the server gated by VPN or ExpressRoute only** — the hub VNet holds the PE; spokes/clients reach it via peering or VPN | Operator responsibility (hub + VPN are outside this template)                                                                                                                                             |
| R5  | **Key Vault with RBAC + purge protection** — no access-policy authorization; managed identity scoped to `Key Vault Secrets User`           | Enforced in `main.bicep`: `enableRbacAuthorization: true`, `enablePurgeProtection: true`, UAMI gets `Secrets User` only                                                                                   |
| R6  | **Storage Account with `allowSharedKeyAccess: false`** — UAMI reads OAuth state via Entra, no account keys                                 | Enforced in `main.bicep`                                                                                                                                                                                  |
| R7  | **User-Assigned Managed Identity (UAMI) for all Azure access** — no passwords in the Container App                                         | Enforced in `main.bicep`                                                                                                                                                                                  |
| R8  | **TLS 1.2 minimum** on Storage Account                                                                                                     | Enforced in `main.bicep`: `minimumTlsVersion: 'TLS1_2'`                                                                                                                                                   |
| R9  | **`--public-url` pinned** to the deployed FQDN — prevents open-redirect style attacks in the OAuth flow                                    | `publicUrl` parameter, becomes a server CLI arg (SEC-F02)                                                                                                                                                 |
| R10 | **Graph application permissions admin-consented only after review** — each permission = tenant-wide privilege                              | Operator responsibility, see [APP_REGISTRATION.md](APP_REGISTRATION.md); post-OBO cutover, revoke all but the 14 app-only exceptions (see [SECURITY_REVIEW_2026-04-20.md](SECURITY_REVIEW_2026-04-20.md)) |

## Recommended controls (SHOULD)

Defense-in-depth. The template does not enforce these, but you should consider them for any long-lived production deployment.

| #   | Control                                                                                                                                                                   | Notes                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Private Endpoints on Key Vault and Storage Account                                                                                                                        | Not emitted by the current template. Hardens lateral movement if the Container App is ever compromised. Requires hub subnet(s) + DNS zones `privatelink.vaultcore.azure.net` and `privatelink.table.core.windows.net` |
| S2  | Conditional Access policy requiring **compliant device + MFA** for the MCP app registration                                                                               | Applied at the tenant level against the `authorizedUsers` oids                                                                                                                                                        |
| S3  | `--max-risk-level low` or `medium` for read-heavy / helpdesk personas                                                                                                     | CLI arg enforced per deployment (SEC-G01). See [RISK_MODEL.md](RISK_MODEL.md)                                                                                                                                         |
| S4  | Separate app registrations for service-to-service vs human OAuth                                                                                                          | Lets you revoke machine access without breaking humans and vice versa                                                                                                                                                 |
| S5  | Log Analytics export to a SIEM with alerting on `/mcp` 401/403 bursts, `/token` 401 bursts, and high-risk tool invocations (role grants, password resets, mailbox grants) | Operator responsibility; the server already emits structured logs with redacted secrets (SEC-F07)                                                                                                                     |
| S6  | Periodic rotation of the Entra client secret (≤ 1 year) and UAMI token cache eviction                                                                                     | See rotation runbook in [HTTP_DEPLOYMENT.md](HTTP_DEPLOYMENT.md)                                                                                                                                                      |
| S7  | Pin the container image to a SHA digest, not a tag                                                                                                                        | Prevents silent upstream supply-chain compromise of the `:0.x.y` tag                                                                                                                                                  |
| S8  | Custom domain + WAF (Front Door or App Gateway) in front of the PE                                                                                                        | Only useful if you expose the server outside the VPN; otherwise the CAE's internal FQDN is sufficient                                                                                                                 |

## Anti-patterns (MUST NOT)

Operators have shipped misconfigurations matching each of these in real deployments. Do not replicate them.

| ✗ Bad                                                                                      | ✗ Why                                                                                                                          | ✓ Do instead                                                                                      |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `--oauth-mode --allow-any-tenant-user` in production                                       | Any tenant user — including guests, service accounts, compromised low-priv users — can authenticate and call admin tools       | Supply `--authorized-users <oid1,oid2,...>` with the explicit admin list                          |
| Deploying with `vnetIntegrated=false` to a tenant that uses the server for real admin work | CAE runs on the Consumption SKU with a public ingress; attackers can hit `/authorize`, fuzz PKCE, spray Entra for valid tokens | Set `vnetIntegrated=true`, supply the infra subnet ID, and connect clients via VPN / ExpressRoute |
| Granting Graph **application** permissions after v0.5.0 has switched to OBO                | Re-introduces the anonymous, app-identity attack path you just eliminated                                                      | Grant delegated scopes only, keep the 14 app-only exceptions as documented                        |
| Storing the client secret in `.env` or Container App secrets instead of Key Vault          | Harder to rotate, no audit trail, exfiltrable via a single `az containerapp show`                                              | Secrets live in Key Vault, read by the UAMI at startup                                            |
| Reusing one app registration across dev, staging, and prod                                 | A dev bug that grants extra permissions silently raises prod risk; compromised dev secret = prod compromise                    | One app reg per environment, separate client secrets, separate Key Vaults                         |
| `kvAdminObjectIds` containing group OIDs that include all-tenant admins                    | Widens the blast radius for secret tampering beyond the operator team                                                          | Explicit user oids, or a small dedicated group                                                    |
| Opening the CAE ingress to `0.0.0.0/0` just to test a new client                           | Test setup silently becomes production exposure                                                                                | Spin up an internal-only staging CAE for testing; deny-by-default on prod                         |
| Running with `--max-risk-level critical` for all deployments                               | Every tool — including destructive ones like `delete-user`, `set-role-assignment` — is available to every authorized caller    | Tier the risk cap per persona and per environment                                                 |

## Deployment checklist

Run through this before every deployment that will receive real admin traffic.

### Pre-deploy

- [ ] App registration created with the minimum delegated scopes required (see [APP_REGISTRATION.md](APP_REGISTRATION.md))
- [ ] Admin consent granted for delegated scopes only (not application permissions, except the 14 documented exceptions)
- [ ] Client secret generated and stored in a secret manager accessible to the operator (not Slack, not a shared doc)
- [ ] The `authorizedUsers` list has been reviewed by the security team and matches the intended admin persona(s)
- [ ] `publicUrl` is the deployed FQDN, no placeholder
- [ ] Container image tag corresponds to a released, signed version (or a SHA digest)
- [ ] `kvAdminObjectIds` contains only the operators who need to rotate secrets
- [ ] Hub VNet, subnet, and Private DNS zone resource group exist and the deploying principal has `Network Contributor` + `Private DNS Zone Contributor` on them
- [ ] `vnetIntegrated=true` in your parameters file, with valid hub subscription / VNet / RG / infrastructure subnet name

### Deploy

- [ ] `az deployment group what-if` reviewed — CAE has `workloadProfiles`, `vnetConfiguration.infrastructureSubnetId` set, and `internal: true`
- [ ] `az deployment group create` with `@infra/parameters.<tenant>.json` (never inline tenant values in CI logs)
- [ ] Key Vault seeded with `client-id`, `tenant-id`, `client-secret`
- [ ] Container App revision reached `Running` state and `/health` returns 200 (from inside the VPN)

### Post-deploy validation

- [ ] Public DNS resolution of the CAE FQDN fails (or returns a non-routable IP) — confirms `internal: true`
- [ ] Private DNS resolution from inside the VPN returns the PE's private IP
- [ ] `curl -H "Authorization: Bearer <user-token>" https://<fqdn>/mcp` from inside VPN returns 200; from outside returns a timeout or DNS failure
- [ ] A non-allowlisted tenant user authenticates via `/authorize` → server returns 403 after the Entra redirect (SEC-F01)
- [ ] An allowlisted user invokes a benign tool (e.g. `get-user`) → Entra **Unified Audit Log** shows the action under that user's UPN, not the app identity
- [ ] Attempted tool invocation above `--max-risk-level` returns `RiskLevelExceeded`, not a silent success
- [ ] Azure Monitor / Log Analytics query returns no `ERROR` or `WARN` spikes in the first 30 min after deploy

### Ongoing

- [ ] Add the MCP app registration to the quarterly access review
- [ ] Subscribe the operator team to [GitHub Security Advisories](https://github.com/okapi-ca/ms-365-admin-mcp-server/security/advisories) for this repo
- [ ] Rotate the client secret before expiry (CI alert recommended)
- [ ] Re-run this checklist on every major version upgrade

## References

- [HTTP_DEPLOYMENT.md](HTTP_DEPLOYMENT.md) — transport, auth flow, Docker, Azure Container Apps how-to
- [APP_REGISTRATION.md](APP_REGISTRATION.md) — Entra app setup, permission catalogue
- [RISK_MODEL.md](RISK_MODEL.md) — tool risk ratings and `--max-risk-level` gating
- [SECURITY_REVIEW_2026-04-20.md](SECURITY_REVIEW_2026-04-20.md) — findings register (SEC-F01..F08, SEC-G01..G03)
- [infra/main.bicep](../infra/main.bicep) — the reference deployment template
- [infra/parameters.example.jsonc](../infra/parameters.example.jsonc) — sanitized parameters template
- Microsoft docs — [Container Apps workload profiles](https://learn.microsoft.com/azure/container-apps/workload-profiles-overview), [Networking in Container Apps](https://learn.microsoft.com/azure/container-apps/networking?tabs=workload-profiles-env)
