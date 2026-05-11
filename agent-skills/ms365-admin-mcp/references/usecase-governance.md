# usecase-governance — Access reviews, entitlement, lifecycle workflows

**When to load:** quarterly access reviews, entitlement management (access packages), joiner/mover/leaver workflows, terms of use.

**Upstream references:** [USE_CASES.md §14 Access reviews and lifecycle workflows](../../../docs/USE_CASES.md).

## Tools in scope

### Access reviews

| Tool                                                                 | Risk                                        |
| -------------------------------------------------------------------- | ------------------------------------------- |
| `list-access-review-definitions`, `get-access-review-definition`     | read                                        |
| `list-access-review-instances`, `get-access-review-instance`         | read                                        |
| `list-access-review-decisions`, `list-access-review-history`         | read                                        |
| `create-access-review-definition`, `update-access-review-definition` | medium                                      |
| `delete-access-review-definition`                                    | high                                        |
| `stop-access-review-instance`                                        | high                                        |
| `send-reminder-access-review`                                        | low                                         |
| `reset-access-review-decisions`                                      | high                                        |
| `apply-access-review-decisions`                                      | high — irreversibly revokes denied accesses |
| `accept-access-review-recommendations`                               | medium                                      |

### Entitlement management (access packages)

| Tool                                                                                                                                                                                                                                                                                                                                   | Risk                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `list-access-packages`, `get-access-package`, `list-access-package-assignments`, `list-access-package-requests`, `list-access-package-catalogs`, `list-connected-organizations`, `get-entitlement-management-settings`, `list-entitlement-assignment-policies`, `list-entitlement-resources`, `list-entitlement-resource-environments` | read                   |
| `create-access-package`, `update-access-package`, `delete-access-package`                                                                                                                                                                                                                                                              | medium / medium / high |
| `create-access-package-catalog`, `update-access-package-catalog`, `delete-access-package-catalog`                                                                                                                                                                                                                                      | medium / medium / high |
| `create-access-package-assignment-policy`, `update-access-package-assignment-policy`, `delete-access-package-assignment-policy`                                                                                                                                                                                                        | medium / medium / high |
| `create-access-package-assignment-request`                                                                                                                                                                                                                                                                                             | medium                 |
| `reprocess-access-package-assignment-request`                                                                                                                                                                                                                                                                                          | low                    |
| `cancel-access-package-assignment-request`                                                                                                                                                                                                                                                                                             | medium                 |

### Lifecycle workflows

| Tool                                                                                                                                                                                                                                         | Risk                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `list-lifecycle-workflows`, `get-lifecycle-workflow`, `list-lifecycle-workflow-templates`, `list-lifecycle-task-definitions`, `get-lifecycle-workflow-settings`, `list-lifecycle-custom-task-extensions`, `list-deleted-lifecycle-workflows` | read                   |
| `create-lifecycle-workflow`, `update-lifecycle-workflow`                                                                                                                                                                                     | medium                 |
| `delete-lifecycle-workflow`                                                                                                                                                                                                                  | high                   |
| `activate-lifecycle-workflow`                                                                                                                                                                                                                | high                   |
| `restore-lifecycle-workflow`                                                                                                                                                                                                                 | medium                 |
| `create-lifecycle-custom-task-extension`, `update-lifecycle-custom-task-extension`, `delete-lifecycle-custom-task-extension`                                                                                                                 | medium / medium / high |

### Terms of use, app consent, PIM groups

`list-terms-of-use-agreements`, `get-terms-of-use-agreement`, `list-terms-of-use-acceptances`, `list-app-consent-requests`, `get-app-consent-request`, `list-user-consent-requests` — all read.

PIM groups:

| Tool                                                                                                                                                       | Risk   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `list-pim-group-assignment-schedules`, `list-pim-group-eligibility-schedules`                                                                              | read   |
| `list-pim-group-assignment-requests`, `list-pim-group-assignment-instances`, `list-pim-group-eligibility-requests`, `list-pim-group-eligibility-instances` | read   |
| `create-pim-group-assignment-request`, `create-pim-group-eligibility-request`                                                                              | high   |
| `cancel-pim-group-assignment-request`, `cancel-pim-group-eligibility-request`                                                                              | medium |

## Pattern 1 — Tracking active access reviews

> _"Status of the quarterly access reviews."_

1. `list-access-review-definitions` → active reviews.
2. For each definition, `list-access-review-instances` → current instance.
3. `list-access-review-decisions` → decisions recorded.
4. Present: Review | % decided | Approved / Denied / Not reviewed | Deadline.
5. For reviews within 3 days of deadline with missing decisions, propose `send-reminder-access-review` (low — confirm).
6. At review close, **`apply-access-review-decisions` (high)** → confirmation required. This revokes accesses marked `denied`.

## Pattern 2 — Creating a new access review

> _"Create a quarterly access review for the `SG-Admins` group."_

Prefer the Entra portal for richer UI, but the API can serve scripted recurring reviews.

1. Dry-run: confirm scope (group), reviewers (manager / self / specific users), recurrence, fallback.
2. `create-access-review-definition` (medium) → confirmation.
3. Document the returned `id` in your governance program tracker.

## Pattern 3 — Lifecycle workflow audit

> _"List joiner/mover/leaver workflows and their last run."_

1. `list-lifecycle-workflows` → all defined workflows.
2. For each, `get-lifecycle-workflow` → category (`joiner` / `mover` / `leaver`), schedule, lastRun.
3. Identify failing runs or workflows not executed for a long time.
4. Recommend config review with HR if applicable.

## Pattern 4 — Access package audit

> _"What access packages exist and who has access?"_

1. `list-access-package-catalogs` → catalogs.
2. `list-access-packages` → packages per catalog.
3. For each package, `list-access-package-assignments` → active beneficiaries.
4. `list-access-package-requests` filtered on status `pendingApproval` → pending requests.
5. Present by catalog with counters.

## Guardrails

- **`apply-access-review-decisions` (high)** is irreversible — denied accesses are revoked immediately. Always dry-run + confirmation.
- **`activate-lifecycle-workflow` (high)** — a misconfigured workflow can disable many accounts. Test on a narrow scope first.
- **`delete-lifecycle-workflow` (high)** loses workflow history. Prefer `update` with disable instead.
- **PIM group assignments on privileged-control groups** are functionally privilege elevation → out-of-band escalation.

## Crosswalk

- Directory role PIM audit → `usecase-identity.md`.
- Accounts linked to access packages → `usecase-identity.md`.
- Compliance / Identity Protection → `usecase-compliance.md`.
