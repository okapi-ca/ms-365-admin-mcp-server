# CYSEC-1420 — Pre-Migration Inventory

**Date:** <!-- Fill after running audit.sh -->  
**Auditor:** <!-- Name -->  
**Ticket:** CYSEC-1420  
**Script used:** `scripts/CYSEC-1420/audit.sh`

---

## 1. Container App — Current Configuration

| Field                     | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| Name                      | `ms365admin-app`                                                     |
| Resource Group            | `rg-ms365admin-prod`                                                 |
| Current Region            | Canada East                                                          |
| Container App Environment | <!-- from 01-cae-full.json → name -->                                |
| CAE VNet integration      | None (public)                                                        |
| Ingress type              | External (public)                                                    |
| Ingress transport         | HTTP/HTTPS                                                           |
| FQDN                      | `ms365admin-app.livelybay-42ee6ab6.canadaeast.azurecontainerapps.io` |
| Managed Identity          | <!-- from 01-containerapp-summary.json → identity.type -->           |
| Min replicas              | <!-- from summary → scale.minReplicas -->                            |
| Max replicas              | <!-- from summary → scale.maxReplicas -->                            |
| Container image           | <!-- from summary → containers[0].image -->                          |
| CPU / Memory              | <!-- from summary → containers[0].resources -->                      |

### Non-sensitive environment variables

<!-- Copy from 01-containerapp-summary.json → containers[0].env_non_secret -->

```
(fill from audit output)
```

---

## 2. Graph Service Principal

| Field            | Value                                                   |
| ---------------- | ------------------------------------------------------- |
| Display name     | `ms365-admin-mcp`                                       |
| App ID           | <!-- from 02-sp-full.json → appId -->                   |
| Object ID        | <!-- from 02-sp-full.json → id -->                      |
| Sign-in audience | <!-- from 02-app-registration.json → signInAudience --> |

### Application permissions currently granted

<!-- Copy from 02-app-registration.json → requiredResourceAccess -->
<!-- Compare against graph-permissions-baseline.md (livrable 3.5) -->

| Permission    | Type        | Justification   | Action        |
| ------------- | ----------- | --------------- | ------------- |
| <!-- perm --> | Application | <!-- reason --> | Keep / Remove |

### Azure RBAC role assignments

<!-- Copy from audit section 2 output -->

| Scope          | Role          | Justification   |
| -------------- | ------------- | --------------- |
| <!-- scope --> | <!-- role --> | <!-- reason --> |

---

## 3. FQDN References Inventory

| System         | Location                                                          | Reference found        | Action required      |
| -------------- | ----------------------------------------------------------------- | ---------------------- | -------------------- |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | Yes / No               | Update after cutover |
| Vecna agents   | `~/Projects/project-vecna/`                                       | Yes / No               | Update after cutover |
| Confluence CSC | Space 440762373                                                   | <!-- search result --> | Update docs          |
| Jira CYSEC     | Search results                                                    | <!-- count -->         | Update tickets       |
| GitHub repo    | `.github/`, README, docs                                          | Yes / No               | Update after cutover |
| Other          | <!-- system -->                                                   | <!-- result -->        | <!-- action -->      |

---

## 4. NSG Rules — Candidate VNets

### `Prod_Backend_nsg` (Canada East — `LCI-Servers_Prod_Backend`)

<!-- Copy from 04-nsg-Prod_Backend_nsg.json -->

| Priority | Direction | Access   | Protocol | Source   | Destination | Port     | Rule name |
| -------- | --------- | -------- | -------- | -------- | ----------- | -------- | --------- |
| <!-- --> | <!-- -->  | <!-- --> | <!-- --> | <!-- --> | <!-- -->    | <!-- --> | <!-- -->  |

### `NSG_CanadaCentral` (Canada Central Hub)

<!-- Copy from 04-nsg-NSG_CanadaCentral.json -->

| Priority | Direction | Access | Protocol | Source | Destination | Port | <!-- --> |
| -------- | --------- | ------ | -------- | ------ | ----------- | ---- | -------- |

---

## 5. Access Logs — Last 30 Days

_Run KQL queries from `scripts/CYSEC-1420/audit.sh` → `05-log-queries.kql` in Log Analytics._

### Traffic summary

| Metric               | Value    |
| -------------------- | -------- |
| Total requests       | <!-- --> |
| Unique source IPs    | <!-- --> |
| Peak hour (UTC)      | <!-- --> |
| Error rate (4xx/5xx) | <!-- --> |

### Source IP addresses

| IP       | Request count | Owner / Expected? |
| -------- | ------------- | ----------------- |
| <!-- --> | <!-- -->      | <!-- -->          |

### User agents observed

| User agent | Count    | Source                           |
| ---------- | -------- | -------------------------------- |
| <!-- -->   | <!-- --> | Claude Desktop / Vecna / Unknown |

### Most-invoked tools (30 days)

| Tool name | Invocations |
| --------- | ----------- |
| <!-- -->  | <!-- -->    |

---

## 6. Open Items / Anomalies

<!-- Document anything unexpected found during the audit -->

| #   | Finding | Risk | Action |
| --- | ------- | ---- | ------ |
| 1   |         |      |        |

---

## Sign-off

| Role                    | Name         | Date | Signature |
| ----------------------- | ------------ | ---- | --------- |
| Auditor                 |              |      |           |
| Architecture validation | Saad Tariq   |      |           |
| RSSI approval           | Marc Bourget |      |           |
