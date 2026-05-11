# usecase-health — Service health and Message Center

**When to load:** active incident, Microsoft service status check, Message Center triage.

**Upstream references:** [USE_CASES.md §9 Service health monitoring](../../../docs/USE_CASES.md).

## Tools in scope

| Tool                    | Usage                                                                      |
| ----------------------- | -------------------------------------------------------------------------- |
| `list-service-health`   | Global M365 service health view.                                           |
| `list-service-issues`   | Active / resolved issues. Filter by `service`, `status`, `startDateTime`.  |
| `list-service-messages` | Message Center (announcements, upcoming changes, action-required notices). |

All read-only. No risk.

## Pattern 1 — Check ongoing incident

> _"Is Microsoft reporting an issue with Exchange?"_

1. `list-service-health` → overview.
2. `list-service-issues` filtered on `service eq 'Exchange Online'` and active status.
3. Present: Issue ID | Title | Impact | Started | Last update | Workaround (if published).
4. If active and impacting users, suggest helpdesk notification.

## Pattern 2 — Message Center triage

> _"What's new in Message Center this week?"_

1. `list-service-messages` filtered on `lastModifiedDateTime ge <-7d>`.
2. Categorize:
   - **Action required** → high priority, route to the appropriate owner.
   - **Plan for change** → planning.
   - **Stay informed** → informational.
3. For action-required items, create a tracker ticket with owner and deadline.

## Pattern 3 — Correlation with internal incident

> _"Teams is slow since 9 a.m. — is it us or Microsoft?"_

1. `list-service-issues` filtered on Teams + active.
2. If MS issue is active → communicate to users (known external).
3. If clean on the MS side → internal investigation (network, proxy, recent CA change).

## Guardrails

- Read-only — no direct risk.
- Service messages can contain references to upcoming security / auth changes (e.g. MFA enforcement, legacy auth deprecation). Treat those as action items.

## Crosswalk

- Security-impacting service messages → potential `usecase-compliance.md` follow-up (CA, auth methods).
- Intune-related service issue → `usecase-intune.md` while the issue is live.
