# Playbook — SharePoint / OneDrive Exfiltration

Response to suspected data exfiltration through SharePoint Online or OneDrive for Business: anomalous external sharing, departing-employee download spike, or an accidental tenant-wide share. The server scopes the exposure, enumerates who has what access, and rolls back permissions at site level.

---

## Trigger signals

- A Defender or DLP alert referencing anomalous download volume or mass-sharing.
- HR notifies of an employee departure; a privileged offboarding review is required.
- A user reports an accidental _Anyone with the link_ share on a sensitive document.
- A quarterly audit surfaces sites with excessive external guests or anonymous links.
- Spike in `get-sharepoint-usage-report` external-users metric.

---

## Scope boundary

This server exposes tenant and site-level SharePoint administration through Graph:

- Tenant external-sharing settings (`get-sharepoint-settings`).
- Sites, site drives, site lists, content types, permissions.
- Site analytics (aggregated activity).
- Tenant-level usage reports.

It does **not** query per-file access events (who opened / downloaded file X, when). That forensic detail lives in Microsoft Purview's Unified Audit Log. If the scenario requires file-level access forensics, pair this playbook with Purview Audit Search or a Purview-scoped MCP. The playbook explicitly flags the handoff where it applies.

---

## Prerequisites

### Presets

- **Investigation (read-only)**
  ```bash
  node dist/index.js --preset sharepointadmin,audit,security,identity,reports
  ```
- **Containment (site permission changes)**
  ```bash
  node dist/index.js --preset sharepointadmin,audit,security,identity,response --allow-writes
  ```

### Delegated permissions (minimum)

- `Sites.FullControl.All` — to revoke / downgrade site permissions.
- `Sites.Read.All`, `Files.Read.All`
- `Directory.Read.All`, `AuditLog.Read.All`
- `Reports.Read.All`
- `InformationProtectionPolicy.Read.All` — to cross-reference sensitivity labels.
- `SecurityAlert.ReadWrite.All`, `SecurityIncident.ReadWrite.All`

See [APP_REGISTRATION.md](../APP_REGISTRATION.md).

### Guardrail — prod site recovery

Before revoking or downgrading a permission on a production site, confirm the site is not a shared team workspace where the revocation would break legitimate collaboration. When in doubt, **downgrade** (`update-site-permission`) instead of **remove** (`delete-site-permission`).

---

## Phase 1 — Scope the exposure

Goal: quantify _what is shared_, _with whom_, _how broadly_.

| #   | Objective                                 | MCP tool(s)                                                        | Notes                                                                                                                                                            |
| --- | ----------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Pull the tenant external-sharing baseline | `get-sharepoint-settings`                                          | Tenant-level defaults for external sharing, guest experience, link expiration. Baseline for what _should_ be allowed.                                            |
| 2   | Identify the suspect site(s)              | `list-sharepoint-sites`, `get-sharepoint-site`                     | Filter by owner UPN for an offboarding scenario; filter by URL / title for a reported incident.                                                                  |
| 3   | Enumerate site permissions                | `list-site-permissions`, `get-site-permission`                     | Per site: grantee identities, roles (`read` / `write` / `owner`), scope (direct user, group, anonymous link, org-wide share).                                    |
| 4   | Enumerate site drives and subsites        | `list-site-drives`, `get-site-default-drive`, `list-site-subsites` | Establishes the full storage surface to review, not just the root site.                                                                                          |
| 5   | Measure site activity                     | `get-site-analytics`, `get-sharepoint-usage-report`                | Views, unique viewers, time window. An activity spike aligned with the alert is a strong signal.                                                                 |
| 6   | Correlate with sensitivity labels         | `list-sensitivity-labels`, `list-sensitivity-sublabels`            | Identifies whether the exposed content _should_ have been labeled `Confidential` / `Highly Confidential` and was not — a labeling gap is a recurring root cause. |

### Sample prompt

> "Site `<siteUrl>` is suspected of excessive external sharing. Pull tenant SharePoint settings, the site profile, every permission entry with grantee identity and role, all site drives and subsites, and the last 30 days of site analytics. Flag anonymous links, org-wide shares, and any external grantee whose domain is not in the tenant's allowlist."

---

## Phase 2 — Actor and timeline

Goal: attribute the permission changes and correlate with user activity. For offboarding scenarios, establish what the departing user shared in their final weeks.

| #   | Objective                            | MCP tool(s)                                       | Notes                                                                                                                                                                                                  |
| --- | ------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7   | Baseline the actor                   | `get-user`                                        | Role, department, manager, tenure. Privileged-role members trigger higher severity.                                                                                                                    |
| 8   | Sharing events from directory audit  | `list-directory-audits`                           | Filter on `category = SharePoint` and `activityDisplayName` patterns like _Add site collection administrator_, _Update site_, _Share_. Populates the operator-attributed timeline visible to Entra ID. |
| 9   | Sign-in activity                     | `list-sign-ins`                                   | Window = last 30 days. Unusual location or anonymous IP during a share-creation window is a strong engagement signal for insider-threat scenarios.                                                     |
| 10  | Related security alerts              | `list-security-alerts`, `list-security-incidents` | DLP, insider-risk, or Defender for Cloud Apps alerts on the same user or site.                                                                                                                         |
| 11  | _(If file-level forensics required)_ | **Handoff to Purview Unified Audit Log**          | Per-file `FileDownloaded`, `FileSyncDownloadedFull`, `SharingSet` events are not exposed by Graph. Hand off the user UPN, site URL, and time window.                                                   |

---

## Phase 3 — Containment

Order: revoke / downgrade at the site first, then tighten the actor's identity if warranted.

| #   | Action                                          | MCP tool                 | Risk       | Effect                                                                                                                          |
| --- | ----------------------------------------------- | ------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 12  | Remove anonymous / excessive share links        | `delete-site-permission` | **high**   | Revokes a specific permission entry. Use for anonymous links and grantees clearly outside policy.                               |
| 13  | Downgrade over-permissive grants                | `update-site-permission` | **medium** | Prefer downgrade (`write` → `read`) over delete when collaboration must continue.                                               |
| 14  | Lock down the site configuration if needed      | `update-sharepoint-site` | **medium** | Constrain site-level sharing capabilities while investigation continues.                                                        |
| 15  | If the actor is confirmed malicious or departed | `revoke-user-sessions`   | **high**   | Per-user session kill. Pair with the [compromised-account](compromised-account.md) playbook if insider compromise is confirmed. |

> Tenant-level external-sharing policy changes (e.g. disabling _Anyone_ links tenant-wide) are **not** exposed as an update tool in this server — that change is made in the SharePoint admin center or via Microsoft Graph beta endpoints not currently mapped. Flag it as a follow-up recommendation in Phase 5.

### Sample containment prompt

> "Containment on site `<siteUrl>`. Dry-run each write. For every permission entry where grantee is `Anonymous` or domain is outside the tenant allowlist: propose `delete-site-permission`. For entries with role `write` on external domains in our partner list: propose `update-site-permission` to `read`. Wait for my confirmation before each write."

---

## Phase 4 — Data governance follow-up

Recurring root cause for exfiltration incidents is missing classification. Close the loop so the same event does not happen twice.

| #   | Objective                          | MCP tool(s)                                                                    | Action                                                                                                                |
| --- | ---------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 16  | Review sensitivity labels coverage | `list-sensitivity-labels`, `list-sensitivity-sublabels`                        | Identify whether a suitable label exists for the exposed content type; recommend mandatory labeling.                  |
| 17  | Check retention labels             | `list-retention-labels`, `list-retention-events`, `list-retention-event-types` | Confirm the content was not under an active retention or hold policy that the revocation could violate.               |
| 18  | Cross-check legal holds            | `list-subject-rights-requests`                                                 | If an open DSAR or litigation hold covers this content, coordinate with Legal before any further action.              |
| 19  | Recommend tenant hardening         | _(advisory — read-only for settings)_                                          | Disable _Anyone_ links tenant-wide, enforce link expiration, require guest MFA. Documented in Phase 5 as a follow-up. |

---

## Phase 5 — Documentation and audit

| #   | Action                         | MCP tool                     | Notes                                                                                                                                  |
| --- | ------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 20  | Update the security incident   | `update-security-incident`   | Classification (`truePositive / dataExfiltration` or `falsePositive / accidentalShare`), status.                                       |
| 21  | Narrative comment on the alert | `add-security-alert-comment` | Scope (site + drives), actor, permission changes applied.                                                                              |
| 22  | Investigation audit log        | `list-directory-audits`      | Filter on the responder, window of the response. Attach to the incident.                                                               |
| 23  | Governance follow-ups register | _(output as markdown)_       | Tenant hardening, labeling gaps, missing retention — anything the investigation surfaced that is out of scope for the incident itself. |

---

## Full-run demo prompt (single-shot)

> "Site `<siteUrl>` was flagged by DLP with an anomalous external-share volume. Run the SharePoint exfiltration playbook:
>
> 1. Scope — pull tenant sharing settings, the site profile, all permissions, drives and subsites, 30-day analytics, and sensitivity labels.
> 2. Actor / timeline — profile the site owner, pull directory-audit sharing events and sign-ins over 30 days, correlate with open security alerts. If file-level forensics are needed, output a handoff for Purview.
> 3. Containment — dry-run every write: delete anonymous / out-of-allowlist grants, downgrade over-permissive partner grants to read-only, wait for my confirmation before each action.
> 4. Governance — check sensitivity and retention label coverage; flag any hold conflict.
> 5. Documentation — update the incident, comment the alert, produce the investigation audit log, and a governance follow-up register for tenant hardening recommendations."

---

## Demo talking points

- **Different tool family** — exercises `sharepointadmin` and `reports` presets, which the first three playbooks do not. Demonstrates the breadth beyond identity.
- **Downgrade-first philosophy** — `update-site-permission` before `delete-site-permission`. Reflects real-world practice: don't break collaboration while responding.
- **Scope honesty** — file-level access forensics is explicitly handed off to Purview rather than faked. Same pattern as the phishing playbook.
- **Prevention loop** — Phase 4 surfaces labeling and tenant-settings gaps. Keeps the playbook from being pure reaction.

---

## Related playbooks

- [Compromised Account](compromised-account.md) — triggered when the sharing actor is a confirmed compromise (not a negligent or departing insider).
- [Phishing Campaign (Tenant-Wide)](phishing-tenant-wide.md) — a phishing lure sometimes drops an OAuth app _or_ coerces a user into sharing a OneDrive link externally.
- [OAuth Illicit Consent](oauth-illicit-consent.md) — apps granted `Files.Read.All` or `Sites.Read.All` through consent phishing show up here as the exfiltration vector.

See [USE_CASES.md](../USE_CASES.md) for the broader catalogue of scenarios.
