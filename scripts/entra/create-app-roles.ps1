<#
.SYNOPSIS
    Creates the four App Roles for ms-365-admin-mcp-server on a given Entra
    app registration.

.DESCRIPTION
    Defines the App Roles that drive per-caller risk-tier filtering in the
    MCP server (see docs/APP_ROLES.md):

      - Tools.Read.All        → declarative read-only tag (no server-side
                                effect — required because the Entra portal
                                forces a role choice when adding a user to
                                "Users and groups").
      - Tools.Write.LowMedium → authorizes write tools at risk levels low + medium
      - Tools.Write.High      → authorizes write tools at risk level high
      - Tools.Write.Critical  → authorizes write tools at risk level critical

    Roles are assignable to both users (delegated / OBO mode) and service
    principals (client_credentials mode). Once created, assignment is done via
    Entra ID portal → Enterprise Applications → <your app> → Users and groups,
    or via Microsoft.Graph PowerShell (see docs/APP_ROLES.md).

    Idempotent: a role already present (matched by `value`) is preserved as-is
    with its current GUID — even if that GUID differs from the script's
    (e.g. role created manually in the portal before this run). Other app roles
    on the registration are not touched.

.REQUIREMENTS
    - PowerShell 7+ with Microsoft.Graph 2.x module
    - Global Administrator or Application Administrator on the target tenant

.PARAMETER ClientId
    The Application (client) ID of the app registration to configure.

.PARAMETER TenantId
    The Entra tenant ID where the app registration lives.

.PARAMETER WhatIf
    Preview the changes without applying them.

.EXAMPLE
    pwsh scripts/entra/create-app-roles.ps1 `
        -ClientId 11111111-2222-3333-4444-555555555555 `
        -TenantId aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee `
        -WhatIf
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$ClientId,

    [Parameter(Mandatory = $true)]
    [string]$TenantId,

    [switch]$WhatIf
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ─── Canonical role definitions (aligned with src/risk-level.ts) ──────────────
# GUIDs are stable and MUST NOT change once roles are assigned to anyone —
# assignments are stored against the GUID, not the `value` string. To retire a
# role, set IsEnabled=$false first, leave a transition period, then delete.
#
# Tools.Read.All is declarative (the server ignores it) but required because
# the Entra portal forces operators to pick a role when adding a user to the
# Enterprise Application's "Users and groups". Without this role, read-only
# users cannot be registered via the portal at all.
$desiredRoles = @(
    @{
        Value       = 'Tools.Read.All'
        DisplayName = 'Tools.Read.All'
        Description = 'Read-only access tag. No write capability — this role is declarative only and ignored by the server. Assign to users/SPs who should appear in Users and groups but only need GET tools.'
        Id          = '2c4d7e1a-9b3f-4c8d-a1e2-5f6789ab0004'
    },
    @{
        Value       = 'Tools.Write.LowMedium'
        DisplayName = 'Tools.Write.LowMedium'
        Description = 'Authorize MCP write tools at risk levels low and medium. Reversible mutations, alert triage, MFA resets.'
        Id          = '2c4d7e1a-9b3f-4c8d-a1e2-5f6789ab0001'
    },
    @{
        Value       = 'Tools.Write.High'
        DisplayName = 'Tools.Write.High'
        Description = 'Authorize MCP write tools at risk level high. Provisioning, sensitive modifications, scoped escalations.'
        Id          = '2c4d7e1a-9b3f-4c8d-a1e2-5f6789ab0002'
    },
    @{
        Value       = 'Tools.Write.Critical'
        DisplayName = 'Tools.Write.Critical'
        Description = 'Authorize MCP write tools at risk level critical. Destructive or irreversible operations (delete-user, revoke-sessions, etc.).'
        Id          = '2c4d7e1a-9b3f-4c8d-a1e2-5f6789ab0003'
    }
)

Write-Host "Configuration:" -ForegroundColor Cyan
Write-Host "  App Client ID : $ClientId"
Write-Host "  Tenant ID     : $TenantId"

# ─── 1. Connect to Microsoft Graph (interactive auth) ─────────────────────────
Write-Host "`nConnecting to Microsoft Graph..." -ForegroundColor Cyan
Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
Import-Module Microsoft.Graph.Applications   -ErrorAction Stop

# Idempotent disconnect — SilentlyContinue covers "not connected", any other
# error is intentionally swallowed so the script can always proceed to Connect.
Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null

Connect-MgGraph `
    -TenantId $TenantId `
    -Scopes "Application.ReadWrite.All" `
    -NoWelcome

$ctx = Get-MgContext
if ($ctx.TenantId -ne $TenantId) {
    throw "Connected to wrong tenant: $($ctx.TenantId). Expected: $TenantId."
}
Write-Host "  Connected as: $($ctx.Account) ($($ctx.TenantId))" -ForegroundColor Green

# ─── 2. Read the current app registration ─────────────────────────────────────
Write-Host "`nFetching app registration $ClientId..." -ForegroundColor Cyan
$app = Get-MgApplication -Filter "appId eq '$ClientId'" -Property "id,appId,displayName,appRoles"
if (-not $app) {
    throw "App registration not found for Client ID $ClientId."
}
$appObjectId = $app.Id
Write-Host "  App Object ID    : $appObjectId"
Write-Host "  Display Name     : $($app.DisplayName)"
Write-Host "  Existing roles   : $($app.AppRoles.Count)"

# ─── 3. Diff: which roles are missing ─────────────────────────────────────────
$existingByValue = @{}
foreach ($r in $app.AppRoles) {
    $existingByValue[$r.Value] = $r
}

$toCreate = [System.Collections.Generic.List[hashtable]]::new()
$alreadyPresent = [System.Collections.Generic.List[string]]::new()
foreach ($d in $desiredRoles) {
    if ($existingByValue.ContainsKey($d.Value)) {
        $alreadyPresent.Add($d.Value)
    } else {
        $toCreate.Add($d)
    }
}

Write-Host "`nState:" -ForegroundColor Cyan
foreach ($v in $alreadyPresent) {
    Write-Host "  = $v (already present, preserved)" -ForegroundColor DarkGray
}
foreach ($d in $toCreate) {
    Write-Host "  + $($d.Value) (to create)" -ForegroundColor Yellow
}

if ($toCreate.Count -eq 0) {
    Write-Host "`nNo roles to create — the app is already configured." -ForegroundColor Green
    Disconnect-MgGraph | Out-Null
    exit 0
}

if ($WhatIf) {
    Write-Host "`n[WhatIf] No changes applied." -ForegroundColor Yellow
    Disconnect-MgGraph | Out-Null
    exit 0
}

# ─── 4. Build the new appRoles collection (existing + new) ────────────────────
$newAppRoles = [System.Collections.Generic.List[object]]::new()
foreach ($r in $app.AppRoles) { $newAppRoles.Add($r) }

foreach ($d in $toCreate) {
    $role = [Microsoft.Graph.PowerShell.Models.MicrosoftGraphAppRole]@{
        Id                 = $d.Id
        Value              = $d.Value
        DisplayName        = $d.DisplayName
        Description        = $d.Description
        AllowedMemberTypes = @('Application', 'User')
        IsEnabled          = $true
    }
    $newAppRoles.Add($role)
}

Write-Host "`nUpdating appRoles..." -ForegroundColor Cyan
Update-MgApplication -ApplicationId $appObjectId -AppRoles $newAppRoles

# ─── 5. Verify ────────────────────────────────────────────────────────────────
$verify = Get-MgApplication -ApplicationId $appObjectId -Property "appRoles"
$verifyByValue = @{}
foreach ($r in $verify.AppRoles) { $verifyByValue[$r.Value] = $r }

$missing = @($desiredRoles | Where-Object { -not $verifyByValue.ContainsKey($_.Value) })
if ($missing.Count -eq 0) {
    Write-Host "  All $($desiredRoles.Count) App Roles are present." -ForegroundColor Green
    Write-Host "`nNext steps:"
    Write-Host "  - Assign roles to users/groups/SPs via the Entra ID portal"
    Write-Host "    (Enterprise Applications → <your app> → Users and groups)"
    Write-Host "  - See docs/APP_ROLES.md for the persona → role mapping."
} else {
    Write-Warning "  Roles missing after update:"
    $missing | ForEach-Object { Write-Warning "    - $($_.Value)" }
}

Disconnect-MgGraph | Out-Null
Write-Host "`nDone." -ForegroundColor Cyan
