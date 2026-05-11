# usecase-audit — Sign-ins, directory audits, deleted items

**When to load:** forensic investigation, traceability of an admin action, audit of suspicious sign-ins, recovery of deleted objects.

**Upstream references:** [USE_CASES.md §3 Suspicious sign-in audit](../../../docs/USE_CASES.md), [§4 Privileged identity hygiene](../../../docs/USE_CASES.md).

## Tools in scope

| Tool                     | Usage                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `list-directory-audits`  | All admin events (object create/modify/delete, role assignments, etc.). Filter by `activityDateTime`, `initiatedBy`, `category`, `result`.      |
| `list-sign-ins`          | Interactive + non-interactive sign-ins. Filter by `userPrincipalName`, `appId`, `createdDateTime`, `riskLevelDuringSignIn`, `status/errorCode`. |
| `list-provisioning-logs` | Provisioning events (Entra Connect, SCIM, etc.).                                                                                                |
| `list-deleted-users`     | Soft-deleted users (recoverable for 30 days).                                                                                                   |
| `list-deleted-groups`    | Soft-deleted groups.                                                                                                                            |

All read-only. No direct mutation risk, but the responses contain **PII** (UPNs, IPs, devices) — handle accordingly.

## Patterns

### Pattern 1 — Post-mutation audit

> _"Who modified the CA policy yesterday?"_

1. `list-directory-audits` with `category eq 'Policy'` and `activityDateTime ge <yesterday 00:00>`.
2. Identify `initiatedBy.user.userPrincipalName`, `targetResources`, `result`.
3. Present as a table: timestamp, actor, action, target, result.

### Pattern 2 — Suspicious sign-in investigation

> _"Risky sign-ins from the last 7 days outside expected geographies."_

1. `list-sign-ins` with `$filter=createdDateTime ge <-7d> and (riskLevelDuringSignIn eq 'medium' or riskLevelDuringSignIn eq 'high')`, `$top=100`.
2. Filter results by `location.countryOrRegion` against the operator's expected list.
3. For recurring patterns (same user, multiple IPs), cross-reference with `list-risk-detections` (see `usecase-compliance.md`).
4. If action is required → `usecase-response.md`.

### Pattern 3 — Recovering a deleted user

> _"User `jdoe@contoso.com` was deleted by mistake — can we restore?"_

1. `list-deleted-users` filtered by UPN or displayName.
2. If found within 30 days, the restore is done via direct Graph (`POST /directory/deletedItems/{id}/restore`) — not currently exposed as an MCP tool. Document the limitation and perform the restore via the Entra portal or PowerShell, logging it as a manual admin action.

## Legal and privacy notes

- Sign-ins and directory audits are **legal audit logs**. Don't export them outside authorized environments.
- For formal investigation requests (HR, Legal), route through `usecase-ediscovery.md` for proper preservation.
- For requests touching personal data of employees in GDPR jurisdictions (or other regional privacy regimes), involve your privacy officer before exporting or sharing raw logs.

## Crosswalk

- Audit a specific user → `usecase-identity.md` for account context.
- Sign-in suspected to lead to compromise → `usecase-response.md`.
- Related risk detections → `usecase-compliance.md`.
- Formal legal preservation → `usecase-ediscovery.md`.
