# Security Incident Response Playbooks

Structured, end-to-end response scenarios for common security incidents, each driven through `ms-365-admin-mcp-server` by an LLM client.

Playbooks are the long-form counterpart to [USE_CASES.md](../USE_CASES.md). A use case is a one-paragraph recipe (context + sample prompt + key tools). A playbook is a multi-phase procedure with tool-level mappings, dry-run guidance, scope boundaries, and demo prompts.

Each playbook follows the same structure:

1. **Trigger signals** — how the scenario is detected.
2. **Scope boundary** (when relevant) — what the server *can* and *cannot* do for this scenario. Forensic or remediation steps that live outside this server are called out and handed off explicitly.
3. **Prerequisites** — presets, delegated permissions, guardrails.
4. **Phased procedure** — investigation → containment → hardening → documentation. Each step maps to a concrete MCP tool with its risk level.
5. **Sample prompts** — per phase + a full-run single-shot prompt.
6. **Demo talking points** — what each playbook showcases that the others do not.

---

## Catalogue

| # | Playbook | Scope | Tool families | Completeness |
|---|---|---|---|---|
| 1 | [Compromised Account](compromised-account.md) | A single user identity is suspected compromised. | `identity`, `audit`, `security`, `response` | End-to-end (investigation → containment → audit). |
| 2 | [Phishing Campaign (Tenant-Wide)](phishing-tenant-wide.md) | A phishing email reached multiple mailboxes. | `security`, `exchange`, `audit`, `identity` | Scoping + handoff (purge happens outside the server). |
| 3 | [OAuth Illicit Consent](oauth-illicit-consent.md) | A malicious OAuth application holds delegated or application permissions. | `identity`, `audit`, `security`, `compliance`, `response` | End-to-end + prevention (permission-grant policy review). |
| 4 | [SharePoint / OneDrive Exfiltration](sharepoint-exfiltration.md) | Anomalous external sharing or mass download on a SharePoint site or OneDrive. | `sharepointadmin`, `audit`, `security`, `identity`, `reports`, `response` | End-to-end at the site level + handoff to Purview for file-level forensics. |

---

## How to run a playbook

Each playbook specifies its presets explicitly. As a baseline:

- Start the server in **read-only** for the investigation phase.
- Restart with `--allow-writes` only for the containment phase, and narrow the preset to what that phase requires.
- For every tool flagged `high` or `critical`, have the LLM **dry-run first** (list the target entities, state the exact operation), wait for operator confirmation, then execute.
- Keep a break-glass / emergency-access account excluded from any containment action. Confirm target UPN is not in the break-glass list before any identity write.

See [USE_CASES.md — General recommendations](../USE_CASES.md#general-recommendations) for the broader safety guidance that applies to every scenario.

---

## How the playbooks relate

```
                 ┌────────────────────────────┐
                 │ Phishing Campaign           │
                 │ (tenant-wide delivery)      │
                 └──────────────┬─────────────┘
                                │ per confirmed victim
                                ▼
                 ┌────────────────────────────┐          ┌─────────────────────────┐
                 │ Compromised Account         │◀────────│ OAuth Illicit Consent    │
                 │ (per user)                  │ per user│ (malicious SP)           │
                 └──────────────┬─────────────┘          └──────────────┬──────────┘
                                │ if data was reached                     │ if scopes were Files.* / Sites.*
                                ▼                                         ▼
                 ┌────────────────────────────────────────────────────────────────┐
                 │ SharePoint / OneDrive Exfiltration                             │
                 │ (site-level exposure + Purview handoff for file forensics)     │
                 └────────────────────────────────────────────────────────────────┘
```

Real incidents rarely fit one playbook cleanly. A phishing campaign can drop an OAuth app that consents to `Files.Read.All` and exfiltrates through SharePoint — three playbooks chained. Run them in sequence; each ends with clear handoff signals.

---

## Demo value (why these four)

Selected to showcase distinct capability surfaces of the server in the shortest possible set:

- **#1 Compromised Account** — end-to-end on a single identity. The baseline demo.
- **#2 Phishing** — shows the server's honesty about scope boundaries. Stops at a handoff package instead of pretending to purge.
- **#3 OAuth Illicit Consent** — shows sophistication (order of operations matters: disable SP *before* revoking sessions) and closes the prevention loop.
- **#4 SharePoint Exfiltration** — widens the narrative beyond identity into data governance. Exercises a completely different preset family.

Together they exercise 9 of the 15 tool-category presets defined in [src/tool-categories.ts](../../src/tool-categories.ts).

---

## Contributing a new playbook

When adding a playbook:

1. Confirm every MCP tool referenced actually exists in [src/endpoints.json](../../src/endpoints.json). Do not include tools that *should* exist — add them to the server first, or handle the gap with an explicit handoff section.
2. Follow the 5-section structure listed at the top of this page. Consistency matters more than length.
3. Classify each write tool's risk (`low` / `medium` / `high` / `critical`) in line with [docs/RISK_MODEL.md](../RISK_MODEL.md).
4. Add the playbook to the catalogue table above and to any relevant *Related playbooks* section in existing files.
