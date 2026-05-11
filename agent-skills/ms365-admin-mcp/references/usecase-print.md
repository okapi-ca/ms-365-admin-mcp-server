# usecase-print — Universal Print

**When to load:** Universal Print inventory, usage, shares audit.

## Tools in scope

| Tool                          | Usage                                   |
| ----------------------------- | --------------------------------------- |
| `list-printers`               | Universal Print printers.               |
| `list-print-shares`           | Printer shares.                         |
| `list-print-connectors`       | Connectors (devices exposing printers). |
| `list-print-services`         | Services.                               |
| `list-print-operations`       | Operations in progress.                 |
| `list-print-task-definitions` | Task definitions.                       |

All read-only.

For usage reports (`list-daily-print-usage-by-*`, `list-monthly-print-usage-by-*`), see `usecase-reports.md`.

## Pattern — Universal Print inventory audit

1. `list-printers` → all printers.
2. `list-print-shares` → shares.
3. `list-print-connectors` → connector status.
4. Present: Printer | Location | Connector | Status | Last seen.
5. Flag offline printers / connectors.

## Crosswalk

- Usage reports → `usecase-reports.md`.
