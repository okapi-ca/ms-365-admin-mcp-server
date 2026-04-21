# CYSEC-1420 — Network Design — Infrastructure Gate

**Date:** 2026-04-21  
**Presenter:** Marc Bourget  
**Validation required from:** Saad Tariq  
**Ticket:** CYSEC-1420 (Epic CYSEC-976)

---

## Context

The `ms365admin-app` Container App currently exposes a **public HTTPS ingress** on the internet:

```
ms365admin-app.livelybay-42ee6ab6.canadaeast.azurecontainerapps.io
```

This MCP server holds **Microsoft Graph application credentials with tenant-wide admin permissions**
(112 Graph API permissions including `RoleManagement.ReadWrite.Directory`,
`Application.ReadWrite.All`, `UserAuthenticationMethod.ReadWrite.All`).

The objective is to restrict access to **LCI VPN clients only**, eliminating public exposure.

---

## Key Constraint Discovered

There is **no Azure vWAN hub in Canada East**. LCI's Canada region hub is
`vWANhub_CanadaCentral_1 (172.22.102.0/23)`.

However, `LCI-Servers_Prod_Backend` is a VNet located in **Canada East** that is already
connected to `vWANhub_CanadaCentral_1`. This cross-region VNet-to-hub attachment is already
validated in production.

---

## Recommended Option: New Subnets in `LCI-Servers_Prod_Backend`

Add two dedicated subnets to the existing **`LCI-Servers_Prod_Backend`** VNet (Canada East).
No new VNet, no new vWAN hub, no campus routing changes.

```
vWANhub_CanadaCentral_1  (172.22.102.0/23)  — existing
        │
        └──► LCI-Servers_Prod_Backend  (Canada East)  — existing VNet on hub
                    │
                    ├── [existing subnets — unchanged]
                    │
                    ├── snet-ms365admin-cae   /27  (32 IPs — CAE infrastructure subnet)
                    │       └── Container App Environment (internal ingress)
                    │               └── ms365admin-app  (private only)
                    │
                    └── snet-ms365admin-pe    /28  (16 IPs — Private Endpoint subnet)
                            └── Private Endpoint → ms365admin-app
```

### Access flow (post-migration)

```
Admin (Marc) ──► Azure VPN P2S ──► vWANhub_CanadaCentral_1
                                            │
                                  inter-VNet routing (existing)
                                            │
                                   LCI-Servers_Prod_Backend
                                            │
                                    Private Endpoint
                                            │
                              Container App (internal only)
                                            │
                                    ms365admin-app
```

Public internet access: **blocked** (ingress set to internal).

---

## What Saad Needs to Confirm

| # | Question | Impact |
|---|----------|--------|
| 1 | Available CIDR range within `LCI-Servers_Prod_Backend` for `/27` + `/28`? | IaC cannot be finalized without this |
| 2 | Any NSG rules on `LCI-Servers_Prod_Backend` that would block Container App→Graph outbound (TCP 443)? | Must allow `AzureContainerAppsInfra` service tag + Graph endpoints |
| 3 | VPN P2S client pool CIDR — is it in the routing table of `vWANhub_CanadaCentral_1`? | Required for admin workstation → Private Endpoint routing |
| 4 | Subscription to deploy the new resources: `LCI Education - Servers` (same as `LCI-Servers_Prod_Backend`)? | Affects Terraform state backend and RBAC scope |
| 5 | Any existing Private DNS zone `privatelink.canadaeast.azurecontainerapps.io` linked to this VNet? | Avoids DNS conflict if already present |

---

## Resources to Create (pending CIDR confirmation)

| Resource | Name (proposed) | Location |
|----------|----------------|----------|
| Subnet (CAE) | `snet-ms365admin-cae` | Canada East (in `LCI-Servers_Prod_Backend`) |
| Subnet (PE) | `snet-ms365admin-pe` | Canada East (in `LCI-Servers_Prod_Backend`) |
| Container App Environment | `prd-cae-ms365admin-cae-01` | Canada East |
| Container App | `prd-cae-ms365admin-app-01` | Canada East |
| Private Endpoint | `prd-cae-ms365admin-pe-01` | Canada East |
| Private DNS Zone | `privatelink.canadaeast.azurecontainerapps.io` | Global |
| Private DNS VNet link | `link-lci-servers-prod-backend` | — |
| Log Analytics Workspace | (reuse existing or new `prd-cae-ms365admin-law-01`) | Canada East |

Tags on all resources:
```
Environment = Production
Owner       = cybersecurity
CostCenter  = <!-- to confirm -->
Project     = CYSEC-1420
Compliance  = Loi25
```

---

## What Is Out of Scope for This Ticket

- Managed identity migration (Graph SP → managed identity) → separate ticket
- `ms365-lci` server (Canada Central) — not included in this sprint
- VPN P2S gateway configuration changes — not modified
- ms365-lci consolidation — not in scope

---

## Estimated Cost Delta

| Resource | Estimated monthly cost (CAD) |
|----------|------------------------------|
| Container App Environment (Consumption) | ~$0 base + workload metered |
| Private Endpoint | ~$12 (2 zones × $0.01/hr) |
| Private DNS Zone | ~$1 |
| **Total delta** | **~$13–15/month** |

No new VNet, no new vWAN hub → **no additional peering or gateway cost**.
