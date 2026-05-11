# usecase-retention — Records management

**When to load:** document retention compliance, retention labels, file plan.

## Tools in scope

| Tool                                                  | Usage                  |
| ----------------------------------------------------- | ---------------------- |
| `list-retention-labels`                               | Retention labels.      |
| `list-file-plan-authorities`                          | File plan authorities. |
| `list-file-plan-categories`                           | Categories.            |
| `list-file-plan-citations`                            | Legal citations.       |
| `list-file-plan-departments`                          | Departments.           |
| `list-file-plan-references`                           | References.            |
| `list-retention-events`, `list-retention-event-types` | Retention events.      |

All read-only.

## Pattern — Retention label audit

1. `list-retention-labels` → published labels.
2. `list-file-plan-categories` → file plan categories.
3. Cross-reference to identify labels without categories or categories without labels.

## Crosswalk

- SharePoint sites with retention → `usecase-sharepointadmin.md`.
- Sensitivity labels → `usecase-infoprotection.md`.
- eDiscovery → `usecase-ediscovery.md`.
