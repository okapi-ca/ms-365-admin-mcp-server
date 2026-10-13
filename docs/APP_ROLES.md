# App Roles — Per-caller write gating

Four Entra App Roles on the `ms-365-admin-mcp-server` registration filter which write tools each caller can invoke, mapped to the [risk-tier model](RISK_MODEL.md). Three write roles drive the filter; one read role is declarative.

## Model

| App Role                | Authorizes writes at risk  | Typical use                                                                                             |
| ----------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `Tools.Read.All`        | _(none — declarative tag)_ | Required by the Entra portal when adding a read-only user to "Users and groups". Ignored by the server. |
| `Tools.Write.LowMedium` | `low` + `medium`           | Alert triage, MFA reset, managed-device sync — reversible mutations                                     |
| `Tools.Write.High`      | `high`                     | Provisioning, sensitive modifications, scoped escalations                                               |
| `Tools.Write.Critical`  | `critical`                 | Destructive / irreversible ops (`delete-user`, `wipe-managed-device`, `revoke-user-sessions`, …)        |

The three **write** roles are **independent and additive** — no implicit hierarchy. A caller with `Tools.Write.LowMedium + Tools.Write.Critical` (but not `High`) can triage alerts and execute incident-response actions, but cannot perform provisioning. This non-contiguous combination is intentional: SOC personas don't always need the middle tier.

`Tools.Read.All` exists because the Entra portal forces the operator to pick a role when adding a principal via **Enterprise Applications → Users and groups**. Without this role, you cannot register a read-only user in the portal at all — they would still authenticate (via `--authorized-users`) but would not appear in the governance view. The server itself ignores this role: the read-only behavior comes from the **absence** of any `Tools.Write.*` claim, not the presence of `Tools.Read.All`.

Roles are assignable to both **users** (delegated / OBO mode) and **service principals** (client_credentials mode). The same `roles` claim in the JWT drives the same filter in both modes.

## How it composes with existing controls

Three layers gate writes; **all three must pass** for a tool to be registered for a caller:

| Layer                | Scope                                                                                   | Configured by       |
| -------------------- | --------------------------------------------------------------------------------------- | ------------------- |
| `--allow-writes`     | Server-wide kill switch. Absent ⇒ zero writes registered, no matter the role.           | Server start-up CLI |
| `--max-risk-level`   | Server-wide cap on registered tiers (e.g. `=high` excludes `critical` for all callers). | Server start-up CLI |
| App Roles (this doc) | Per-caller tier filter from the JWT `roles` claim.                                      | Entra ID assignment |

Stdio transport has no caller identity, so the App Role filter is bypassed there — only `--allow-writes` and `--max-risk-level` apply. This preserves the local-developer workflow.

A caller authenticated to HTTP transport **without** any `Tools.Write.*` role is effectively read-only: write tools are not registered in their `tools/list` response (silent — not a 403).

The filter goes by HTTP method, not by intent. A few `POST` endpoints only read — `run-hunting-query` and the Intune `intune-*-report` tools — and they are classified `low`, so they require `Tools.Write.LowMedium`. A caller with `Tools.Read.All` alone, or `Tools.Write.Critical` alone, does not get them.

A token with no `roles` claim at all counts as no role. Every HTTP caller is authenticated, so the filter never falls back to the unfiltered stdio behavior.

## Who can connect — `--authorize-by-app-role`

By default the HTTP server admits only the user object IDs listed in `--authorized-users`. With `--authorize-by-app-role`, it admits instead any user whose token carries one of the four roles above, so the Enterprise App assignment (**Users and groups**) becomes the access list and groups can be used. Requirements and guarantees:

- `appRoleAssignmentRequired` must be `true` on the Enterprise App, so Entra refuses to issue a token to anyone not assigned.
- The server checks the claim itself, so a token for another audience (Graph, which the OBO flow requires the server to accept) is rejected even if the `scp` check (SEC-F03) is disabled.
- A user with no role in the token gets `403`. With `--authorized-users` also set, a user must pass both checks.
- Entra puts group-assigned roles in the token only for **direct** members of the assigned group. Nested groups are not expanded: assign each sub-group.
- Assignment changes apply at the user's next token (60–90 min at most), or right away after a new sign-in.

## Setup — one-shot

Create the four roles on the app registration via the included script:

```bash
pwsh scripts/entra/create-app-roles.ps1 -ClientId <appId> -TenantId <tid> -WhatIf
pwsh scripts/entra/create-app-roles.ps1 -ClientId <appId> -TenantId <tid>
```

Idempotent — re-running it after the initial setup is a no-op. The script preserves any role already present (matched by `value`) with its current GUID, even if that GUID differs from the script's (e.g. role created manually in the portal before the run).

After running, the four roles are visible in Entra ID portal → **App registrations** → _ms-365-admin-mcp-server_ → **App roles**.

## Assigning a role

### Via the Azure portal (preferred for ad-hoc grants)

1. Entra ID → **Enterprise Applications** → _ms-365-admin-mcp-server_
2. **Users and groups** → **Add user/group**
3. Select the user, group, or service principal
4. Pick the role and confirm

### Via PowerShell (scriptable / bulk)

```powershell
Connect-MgGraph -TenantId $tenantId -Scopes "AppRoleAssignment.ReadWrite.All", "Application.Read.All"

# Look up the SP for the MCP server (the assignment target)
$appSp = Get-MgServicePrincipal -Filter "appId eq '<MCP_APP_CLIENT_ID>'"
$role  = $appSp.AppRoles | Where-Object { $_.Value -eq 'Tools.Write.LowMedium' }

# Assign to a user (the principal):
$user = Get-MgUser -Filter "userPrincipalName eq 'alice@contoso.com'"
New-MgUserAppRoleAssignment `
    -UserId $user.Id `
    -PrincipalId $user.Id `
    -ResourceId  $appSp.Id `
    -AppRoleId   $role.Id

# Assign to a group (members inherit):
$group = Get-MgGroup -Filter "displayName eq 'SOC Operators'"
New-MgGroupAppRoleAssignment `
    -GroupId   $group.Id `
    -PrincipalId $group.Id `
    -ResourceId  $appSp.Id `
    -AppRoleId   $role.Id
```

## Audit — who has what

```powershell
$appSp = Get-MgServicePrincipal -Filter "appId eq '<MCP_APP_CLIENT_ID>'"
Get-MgServicePrincipalAppRoleAssignedTo -ServicePrincipalId $appSp.Id -All `
  | Select-Object PrincipalDisplayName, PrincipalType,
                  @{N='Role';E={
                      ($appSp.AppRoles | Where-Object Id -eq $_.AppRoleId).Value
                  }},
                  CreatedDateTime
```

This is the canonical "who has write access" report. Keep an exported snapshot in the audit trail at least quarterly.

## Recommended persona mapping

These are starting points — refine by team practice. Always grant the _narrowest_ combination that does the job.

| Persona                        | Roles                                            | Rationale                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SOC analyst (L1 triage)**    | `Tools.Write.LowMedium`                          | Comment on alerts, sync devices, run hunting queries. No state-changing ops.                                                                                  |
| **SOC responder (L2/L3)**      | `Tools.Write.LowMedium` + `Tools.Write.Critical` | Triage + incident response (revoke sessions, disable accounts). Skip `High` if not needed for the playbook.                                                   |
| **Identity / IT Ops**          | `Tools.Write.LowMedium` + `Tools.Write.High`     | Provisioning, group changes, conditional access updates. No destructive ops.                                                                                  |
| **Tenant admin (break-glass)** | All three                                        | Emergency-only. Pair with PIM activation and short token TTL.                                                                                                 |
| **Read-only analyst**          | `Tools.Read.All`                                 | Reports, audit logs. No `Tools.Write.*` assigned ⇒ read-only session. Tag is declarative — used only so the user shows up in Users and groups for governance. |
| **Automation SP (low-risk)**   | `Tools.Write.LowMedium`                          | Scripted hygiene tasks. Pair with `--max-risk-level=medium` on the server they call.                                                                          |

## Operational considerations

- **Role IDs are stable.** The GUIDs assigned by `create-app-roles.ps1` are hard-coded. Once role assignments exist, do not change those IDs — assignments are stored against the GUID, not the `value` string.
- **Disabling vs deleting.** To retire a role, set `isEnabled = false` first, leave it for a transition period, then delete. Deletion drops all assignments referencing it.
- **JWT propagation delay.** App role assignment changes don't apply to currently-valid tokens. Existing tokens carry stale `roles` claims until they expire (Entra defaults: 60–90 min for access tokens). For immediate revocation, also revoke the user's sessions.
- **Conditional Access.** App Roles are independent from CA policies. A user can have a role assigned but still be blocked by CA at sign-in. Treat the two layers as orthogonal.

## Implementation references

- Filter logic: [`src/graph-tools.ts`](../src/graph-tools.ts) — see the `writeRiskTiers` parameter
- Role → tier mapping: [`src/risk-level.ts`](../src/risk-level.ts) `computeWriteRiskTiers()`
- JWT claim extraction: [`src/token-validator.ts`](../src/token-validator.ts), [`src/user-token-authorization.ts`](../src/user-token-authorization.ts)
- Tests: [`test/risk-level.test.ts`](../test/risk-level.test.ts) (mapping), [`test/graph-tools-role-filter.test.ts`](../test/graph-tools-role-filter.test.ts) (registration filter), [`test/http-approle-e2e.test.ts`](../test/http-approle-e2e.test.ts) (end to end: the `roles` claim reaching `tools/list` over HTTP, and stdio unchanged)
- Tier classification rubric: [`docs/RISK_MODEL.md`](RISK_MODEL.md)
