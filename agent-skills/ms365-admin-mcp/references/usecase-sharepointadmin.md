# usecase-sharepointadmin — SharePoint tenant administration

**When to load:** external sharing audit, oversized sites, tenant SharePoint permission governance.

**Upstream references:** [USE_CASES.md §12 SharePoint administration](../../../docs/USE_CASES.md), [SharePoint exfiltration playbook](../../../docs/playbooks/sharepoint-exfiltration.md).

## Tools in scope

### Read — tenant

| Tool                      | Usage                                                        |
| ------------------------- | ------------------------------------------------------------ |
| `get-sharepoint-settings` | Tenant SharePoint settings (external sharing default, etc.). |

### Read — sites

| Tool                                                                                 | Usage                          |
| ------------------------------------------------------------------------------------ | ------------------------------ |
| `list-sharepoint-sites`, `get-sharepoint-site`                                       | All sites / single site.       |
| `list-site-drives`, `get-site-default-drive`                                         | Document libraries.            |
| `list-site-lists`, `get-site-list`, `list-site-list-items`, `list-site-list-columns` | Lists / items / columns.       |
| `list-site-columns`, `list-site-content-types`                                       | Site columns / content types.  |
| `list-site-permissions`, `get-site-permission`                                       | Permissions applied to a site. |
| `get-site-analytics`                                                                 | Usage analytics.               |
| `list-site-subsites`                                                                 | Subsites.                      |

### Write

| Tool                     | Risk   |
| ------------------------ | ------ |
| `update-sharepoint-site` | medium |
| `create-site-list`       | low    |
| `update-site-list`       | low    |
| `delete-site-list`       | high   |
| `create-site-list-item`  | low    |
| `update-site-list-item`  | low    |
| `delete-site-list-item`  | medium |
| `create-site-permission` | medium |
| `update-site-permission` | medium |
| `delete-site-permission` | high   |

## Pattern 1 — External sharing audit

> _"Which sites share externally?"_

1. `get-sharepoint-settings` → tenant-wide external sharing setting.
2. `list-sharepoint-sites` (paginate on large tenants) → all sites.
3. For sensitive sites (operator-defined: Legal, HR, Finance, Security, Executive):
   - `list-site-permissions` → identify guests, anonymous links.
   - Flag external permissions.
4. Present by site criticality.

## Pattern 2 — Top sites by storage

> _"Top 20 sites by size."_

1. `list-sharepoint-sites` sorted by `quota.used` or `siteCollection.usage`.
2. Cross-reference with `get-site-analytics` for activity (active vs. dormant).
3. Present: Site | Owner | Storage used | Last activity.
4. For dormant sites > X months, propose an archive plan.

## Pattern 3 — Permission audit on a sensitive site

> _"Who has access to the `Finance` site?"_

1. `get-sharepoint-site` (siteId).
2. `list-site-permissions` → root permissions.
3. `list-site-subsites` + permissions per subsite (broken inheritance?).
4. For each permission, identify the grantee (user, group, app).
5. Flag apps with `Sites.FullControl.All` or equivalent.

## Guardrails

- **`delete-site-permission` (high)** can break access to operational content. Always verify dependencies first.
- **`update-sharepoint-site`** — site-level settings changes (sharing capabilities, sensitivity labels) cascade.
- **List / item changes via API** — SharePoint has complex logic (calculated fields, workflows, retention). Prefer the UI unless bulk operations are justified.
- **Tenant settings (`get-sharepoint-settings`)** — no write tool exposed. Modify via SharePoint Admin Center.

## Crosswalk

- Applied sensitivity labels → `usecase-infoprotection.md`.
- Records management / retention on sites → `usecase-retention.md`.
- Identities with access → `usecase-identity.md`.
- End-to-end exfiltration scenario → [`docs/playbooks/sharepoint-exfiltration.md`](../../../docs/playbooks/sharepoint-exfiltration.md).
