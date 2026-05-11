# usecase-threatintel — Threat intelligence and KQL hunting

**When to load:** IOC investigation (IP, domain, hash, certificate), WHOIS / DNS enrichment, KQL queries against Defender Advanced Hunting.

**Upstream references:** [USE_CASES.md §13 Advanced threat hunting](../../../docs/USE_CASES.md).

## Tools in scope

### KQL hunting

| Tool                | Risk                                                              |
| ------------------- | ----------------------------------------------------------------- |
| `run-hunting-query` | low — POST but read-only in practice (KQL does not mutate state). |

### Threat intel — hosts and infrastructure

| Tool                                                                                                | Usage                                 |
| --------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `list-threat-intel-hosts`, `get-threat-intel-host`                                                  | Hosts (IPs, domains).                 |
| `get-threat-intel-host-whois`                                                                       | WHOIS.                                |
| `list-threat-intel-host-pairs`                                                                      | Relationships between hosts.          |
| `list-threat-intel-host-components`                                                                 | Detected components (web tech, etc.). |
| `list-threat-intel-host-ports`, `list-threat-intel-host-trackers`, `list-threat-intel-host-cookies` | Ports, trackers, cookies observed.    |
| `list-threat-intel-ssl-certs`, `list-ssl-certificates`                                              | SSL certificates.                     |
| `list-threat-intel-subdomains`                                                                      | Subdomains.                           |
| `list-passive-dns-records`                                                                          | Passive DNS history.                  |

### Threat intel — articles and profiles

| Tool                                                     | Usage                            |
| -------------------------------------------------------- | -------------------------------- |
| `list-threat-intel-articles`, `get-threat-intel-article` | Microsoft Threat Intel articles. |
| `list-threat-intel-article-indicators`                   | IOCs in an article.              |
| `list-threat-intel-profiles`, `get-threat-intel-profile` | Threat actor profiles.           |
| `list-threat-intel-profile-indicators`                   | IOCs in a profile.               |

### Threat intel — vulnerabilities and WHOIS records

| Tool                                                                  | Usage                     |
| --------------------------------------------------------------------- | ------------------------- |
| `list-threat-intel-vulnerabilities`, `get-threat-intel-vulnerability` | CVEs.                     |
| `list-threat-intel-whois-records`, `get-threat-intel-whois-record`    | Historical WHOIS records. |

## Pattern 1 — IOC investigation (suspect IP)

> _"IP `203.0.113.42` appears in our logs — investigate."_

### Step 1 — Internal activity

```
list-sign-ins($filter="ipAddress eq '203.0.113.42' and createdDateTime ge <-14d>")
```

Identify users / apps with sign-ins from this IP.

### Step 2 — KQL hunting for broader activity

```
run-hunting-query(query="
  union
    (DeviceNetworkEvents | where RemoteIP == '203.0.113.42'),
    (CloudAppEvents | where IPAddress == '203.0.113.42'),
    (AADSignInEventsBeta | where IPAddress == '203.0.113.42')
  | project Timestamp, Type=$table, AccountUpn, DeviceName, ActionType
  | order by Timestamp desc
  | take 100
")
```

### Step 3 — Threat Intel enrichment

```
list-threat-intel-hosts($filter="hostname eq '203.0.113.42'")
get-threat-intel-host-whois(...)
list-passive-dns-records(...)
list-threat-intel-articles($filter="indicators contains '203.0.113.42'")
```

### Step 4 — Synthesis

Present:

- Internal activity (who touched the IP, when, context).
- External reputation (MS articles, threat actor profiles).
- WHOIS / passive DNS (historical resolutions, ownership).
- Recommendation: block (Conditional Access named location), monitor, or ignore.

### Step 5 — If confirmed malicious

- Create or enrich a CA named location for blocking (`usecase-compliance.md`).
- If users compromised → `usecase-response.md`.
- File an incident ticket documenting the IOC, investigation, and decision.

## Pattern 2 — Threat intel for an active CVE

> _"CVE-2026-XXXX — are we exposed?"_

1. `list-threat-intel-vulnerabilities` filtered on CVE ID.
2. `get-threat-intel-vulnerability` → details (severity, products affected).
3. Cross-reference with:
   - `list-detected-apps` (Intune) if the affected product is an app.
   - `list-managed-devices` filtered on OS / version.
4. If exposure confirmed: file a patching plan with the platform owner.

## Pattern 3 — Threat actor attribution

> _"Has this campaign been attributed to a known actor?"_

1. `list-threat-intel-profiles` → Microsoft profiles.
2. For relevant profiles, `get-threat-intel-profile` → TTPs, known IOCs.
3. `list-threat-intel-profile-indicators` → indicators to monitor.
4. Push indicators into KQL hunting to verify tenant exposure.

## KQL best practices

- **Always limit** — `take 100` or less during exploration.
- **Index early** — `where Timestamp >= ...` near the top of the query.
- **No PII in shared comments** — sanitize before sharing the query externally.
- **Test on a short window** before broadening.

## Guardrails

- `run-hunting-query` is **low risk** (read-only) but can consume Defender resources. Avoid mass queries on repeat.
- Don't run queries on unvalidated external requests — this is internal investigation.
- KQL result rows can contain PII (UPN, employee home IP). Distribute carefully.

## Crosswalk

- IOC in a Defender alert → `usecase-security.md`.
- Compromised user related to IOC → `usecase-response.md`.
- Related sign-ins → `usecase-audit.md`.
- Exposed devices → `usecase-intune.md`.
