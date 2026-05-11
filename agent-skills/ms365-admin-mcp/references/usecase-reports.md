# usecase-reports — M365 usage reports

**When to load:** license optimization, adoption metrics, identifying inactive users, monthly reporting.

**Upstream references:** [USE_CASES.md §10 Usage reports and license optimization](../../../docs/USE_CASES.md).

## Tools in scope

| Tool                                                                                                                                             | Usage                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `get-teams-activity-report`                                                                                                                      | Teams activity (chats, calls, meetings). |
| `get-email-activity-report`                                                                                                                      | Email activity (sent, received, read).   |
| `get-active-users-report`                                                                                                                        | Active users across services.            |
| `get-active-user-counts-report`                                                                                                                  | Aggregated counts.                       |
| `get-sharepoint-usage-report`, `get-onedrive-usage-report`, `get-mailbox-usage-report`, `get-m365-apps-usage-report`                             | Per-service usage.                       |
| `list-user-registration-details`                                                                                                                 | MFA registration status.                 |
| `list-daily-print-usage-by-printer`, `list-daily-print-usage-by-user`, `list-monthly-print-usage-by-printer`, `list-monthly-print-usage-by-user` | Universal Print usage.                   |

All read-only.

## Notes

- **Period:** most reports accept `D7`, `D30`, `D90`, `D180`.
- **PII:** depending on the tenant's privacy settings, names may be anonymized in report output. For real UPNs, verify `displayConcealedNames` is disabled in the Microsoft 365 Admin Center reports privacy setting.
- **Format:** reports typically return CSV — format clearly when presenting.

## Pattern 1 — E5 license optimization

> _"E5 users inactive for 30 days to reassign."_

1. `get-active-users-report` (period `D30`) → users active per service.
2. `list-subscribed-skus` (see `usecase-compliance.md`) → identify the E5 SKU.
3. `list-users` filtered on E5 licenses → license holders.
4. Cross-reference: E5 holders ABSENT from the activity report = reassign candidates.
5. Present: User | Department | Manager | License date | Activity.
6. Plan: manager review → reassign.

## Pattern 2 — Teams adoption

> _"Teams adoption by department."_

1. `get-teams-activity-report` (period `D30`).
2. Cross-reference with `list-users` for `companyName` / `department`.
3. Aggregate: Department | Active users | Total users | % adoption.

## Pattern 3 — MFA registration audit

> _"How many users have no MFA configured?"_

1. `list-user-registration-details` → status per user.
2. Filter `isMfaRegistered eq false`.
3. Cross-reference with `list-users` for `accountEnabled eq true` (only count active accounts).
4. Present: global count + breakdown by department.
5. For admin / privileged accounts without MFA → immediate escalation.

## Pattern 4 — Monthly KPI reporting

Recurring pattern. Queries to run at the start of the month for the previous month:

| KPI                    | Tool                                  |
| ---------------------- | ------------------------------------- |
| Active users count     | `get-active-user-counts-report` (D30) |
| MFA registration %     | `list-user-registration-details`      |
| Mailbox storage trends | `get-mailbox-usage-report` (D30)      |
| OneDrive usage         | `get-onedrive-usage-report` (D30)     |
| SharePoint usage       | `get-sharepoint-usage-report` (D30)   |

## Guardrails

- No writes, no direct risk.
- Reports can contain sensitive user data (volume, frequency of use). Distribute only to authorized recipients.

## Crosswalk

- License management → `usecase-compliance.md`.
- Identifying inactive users → `usecase-identity.md`.
