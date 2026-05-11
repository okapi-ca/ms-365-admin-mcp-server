# usecase-teamsadmin — Teams tenant-level administration

**When to load:** Teams / channel / app management at the tenant level, Teams admin policies.

**Upstream references:** Teams is touched in passing throughout [USE_CASES.md](../../../docs/USE_CASES.md); no dedicated section.

## Tools in scope

### Read — teams

| Tool                                                                              | Usage                             |
| --------------------------------------------------------------------------------- | --------------------------------- |
| `list-teams`, `get-team`                                                          | Teams.                            |
| `list-team-admin-channels`, `get-team-admin-channel`                              | Channels.                         |
| `list-team-admin-members`, `get-team-admin-member`                                | Members.                          |
| `list-team-installed-apps`, `list-team-operations`, `list-team-permission-grants` | Apps / operations / permissions.  |
| `list-deleted-teams`                                                              | Soft-deleted teams (recoverable). |

### Write — teams

| Tool                        | Risk                                  |
| --------------------------- | ------------------------------------- |
| `create-team`               | medium                                |
| `update-team`               | medium                                |
| `delete-team`               | **critical** — out-of-band escalation |
| `create-team-admin-channel` | low                                   |
| `delete-team-admin-channel` | high                                  |
| `add-team-admin-members`    | medium                                |
| `remove-team-admin-members` | medium                                |
| `archive-team`              | medium                                |
| `unarchive-team`            | low                                   |
| `clone-team`                | medium                                |

### Apps and settings

| Tool                                                                                                                                                    | Usage / Risk |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `list-teams-catalog-apps`, `get-teams-catalog-app`, `list-teams-app-definitions`                                                                        | read         |
| `get-teams-app-settings`                                                                                                                                | read         |
| `update-teams-app-settings`                                                                                                                             | high         |
| `get-teams-admin-settings`, `list-teams-user-configurations`, `get-teams-admin-policy`, `list-teams-policy-assignments`, `list-teams-phone-assignments` | read         |

## Pattern 1 — Teams inventory

> _"How many active Teams, how many dormant?"_

1. `list-teams` → all.
2. For each, `get-team` → activity status, member count.
3. Identify dormant (no activity 90d+).
4. Cross-reference with `list-deleted-teams` for lifecycle view.

## Pattern 2 — Archive an inactive team

> _"Team `Project-Atlas` is finished — archive it."_

1. `get-team` → confirm.
2. `list-team-admin-members` → notify owners.
3. `archive-team` (medium) → confirmation.

## Pattern 3 — Installed third-party apps audit

> _"Which third-party apps are installed in Teams?"_

1. `list-teams-catalog-apps` filtered on `distributionMethod eq 'organization'` or `'sideloaded'`.
2. For each suspicious app, `get-teams-catalog-app` → permissions, publisher.
3. `list-team-permission-grants` filtered → teams that granted access.
4. Flag non-Microsoft apps with elevated permissions.

## Guardrails

- **`delete-team` (critical)** — 30-day soft-delete window, but historical conversations matter. Out-of-band escalation for teams with operational history.
- **`update-teams-app-settings` (high)** — tenant-wide Teams impact. Requires formal change management.
- **`add-team-admin-members` / `remove-`** can affect private conversations. Verify the request comes from a legitimate owner.

## Crosswalk

- Member identities → `usecase-identity.md`.
- Compliance / retention on Teams content → `usecase-retention.md`.
- eDiscovery on Teams conversations → `usecase-ediscovery.md`.
