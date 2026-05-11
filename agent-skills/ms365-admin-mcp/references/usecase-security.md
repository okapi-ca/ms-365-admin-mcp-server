# usecase-security — Alert and incident triage

**When to load:** daily Defender alert triage, incident follow-up, attack simulation monitoring, or any request starting with "alerts", "incidents", "attack sim".

**Upstream references:** [USE_CASES.md §1 Daily security monitoring](../../../docs/USE_CASES.md), [§13 Advanced threat hunting](../../../docs/USE_CASES.md).

## Tools in scope

### Read

| Tool                      | Usage                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `list-security-alerts`    | Defender XDR alerts. Filter by `severity`, `status`, `lastModifiedDateTime`.        |
| `get-security-alert`      | Single alert detail. ⚠ Can time out on large alerts — see SKILL.md troubleshooting. |
| `list-security-incidents` | Incidents (alert groupings).                                                        |
| `get-security-incident`   | Single incident detail + linked alerts.                                             |
| `list-attack-simulations` | Phishing simulation campaigns.                                                      |
| `get-attack-simulation`   | Single simulation — click rate, credential submission rate, affected users.         |

### Write

| Tool                         | Risk   | When                                                                  |
| ---------------------------- | ------ | --------------------------------------------------------------------- |
| `update-security-alert`      | medium | Change status (`newAlert`, `inProgress`, `resolved`), classification. |
| `update-security-incident`   | medium | Same at the incident level.                                           |
| `add-security-alert-comment` | low    | Annotate an alert with investigation context.                         |
| `create-attack-simulation`   | high   | Launch a new phishing simulation — coordinate with comms first.       |
| `update-attack-simulation`   | medium | Modify an existing simulation.                                        |
| `delete-attack-simulation`   | medium | Removes the simulation record — prefer archival.                      |

## Patterns

### Pattern 1 — Daily triage

> _"Summarize alerts from the last 24 hours."_

1. `list-security-alerts` with `$filter=createdDateTime ge <yesterday>` and `$top=50`.
2. Group mentally by `severity` and `status`.
3. For unworked `high` alerts, show a compact summary: title, severity, target user/device, timestamp.
4. On detail request, `get-security-alert` by ID. On timeout, fall back to fields already returned by `list`.
5. Cross-reference with `list-security-incidents` for the grouped view.

### Pattern 2 — Incident follow-up

> _"Where are we on incident INC-12345?"_

1. `get-security-incident` by ID.
2. Enumerate linked alerts, status, assignee, comments.
3. Propose `add-security-alert-comment` to log an investigation note.
4. If resolved, propose `update-security-incident` to set `resolved` — medium, confirm.

### Pattern 3 — Attack simulation results

> _"How did the latest phishing simulation go?"_

1. `list-attack-simulations` to identify the recent campaign.
2. `get-attack-simulation` for metrics (click rate, credential submission rate, affected users).
3. Offer to export a summary for stakeholders.

## Guardrails

- **Status changes** (`update-security-alert`, `update-security-incident`) are medium — confirm with the operator that the transition is justified. Moving to `resolved` without investigation evidence is risky.
- **`create-attack-simulation`** is high. A phishing simulation reaching users requires coordination with the comms team — never launch without out-of-band sign-off.
- **`delete-attack-simulation`** loses historical data useful for KPIs. Prefer archival.

## Crosswalk

- Account named in an alert → load `usecase-response.md` for containment.
- IOC in the alert (IP, domain) → load `usecase-threatintel.md` for enrichment.
- Related suspicious sign-in → load `usecase-audit.md`.
