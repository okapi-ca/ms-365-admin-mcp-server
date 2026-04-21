<#
.SYNOPSIS
    Accorde le consentement administrateur pour les 103 permissions déléguées
    requises par le modèle OBO de ms365admin-app (CYSEC-1424).

.DESCRIPTION
    Ce script :
    1. Lit CLIENT_ID et TENANT_ID depuis 1Password (compte lcieducation.1password.com)
    2. Connecte au tenant LCI avec Connect-MgGraph (auth interactive Global Admin)
    3. Résout les GUIDs des 103 permissions déléguées depuis le SP Microsoft Graph
    4. Met à jour le requiredResourceAccess de l'inscription d'application
    5. Crée ou met à jour l'oauth2PermissionGrant (admin consent AllPrincipals)

.REQUIREMENTS
    - 1Password CLI (op) — compte lcieducation.1password.com connecté
    - PowerShell 7+ avec module Microsoft.Graph 2.x
    - Compte Global Admin sur le tenant LCI

.USAGE
    pwsh scripts/CYSEC-1424/grant-delegated-consent.ps1 [-WhatIf]
#>
param(
    [switch]$WhatIf
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ─── 1. Secrets depuis 1Password ──────────────────────────────────────────────
Write-Host "Lecture des secrets depuis 1Password (compte LCI)..." -ForegroundColor Cyan
$clientId = (op item get "ms-365-admin-mcp-server" `
    --account lcieducation.1password.com `
    --vault "AAD Enterprise Apps - High Privilege" `
    --fields "Client ID" 2>$null).Trim()
$tenantId = (op item get "ms-365-admin-mcp-server" `
    --account lcieducation.1password.com `
    --vault "AAD Enterprise Apps - High Privilege" `
    --fields "Tenant ID" 2>$null).Trim()

if (-not $clientId -or -not $tenantId) {
    throw "Impossible de lire CLIENT_ID ou TENANT_ID depuis 1Password."
}
Write-Host "  App Client ID : $clientId"
Write-Host "  Tenant ID     : $tenantId"

# ─── 2. Connexion Microsoft Graph (auth interactive) ─────────────────────────
Write-Host "`nConnexion au tenant LCI via Microsoft Graph..." -ForegroundColor Cyan
Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
Import-Module Microsoft.Graph.Applications   -ErrorAction Stop

# Déconnecter toute session existante pour éviter la réutilisation d'un mauvais token
try { Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null } catch {}

Connect-MgGraph `
    -TenantId $tenantId `
    -Scopes "Application.ReadWrite.All", "DelegatedPermissionGrant.ReadWrite.All" `
    -NoWelcome

$ctx = Get-MgContext
if ($ctx.TenantId -ne $tenantId) {
    throw "Connexion au mauvais tenant : $($ctx.TenantId). Attendu : $tenantId. Déconnectez-vous de tout compte Microsoft et relancez."
}
Write-Host "  Connecté : $($ctx.Account) ($($ctx.TenantId))" -ForegroundColor Green

# ─── 3. Liste des 103 permissions déléguées ───────────────────────────────────
$delegatedPermissions = @(
    'AccessReview.Read.All'
    'AccessReview.ReadWrite.All'
    'AdministrativeUnit.Read.All'
    'AdministrativeUnit.ReadWrite.All'
    'Agreement.Read.All'
    'APIConnectors.Read.All'
    'AppCatalog.Read.All'
    'Application.Read.All'
    'Application.ReadWrite.All'
    'AppRoleAssignment.Read.All'
    'AppRoleAssignment.ReadWrite.All'
    'AttackSimulation.Read.All'
    'AttackSimulation.ReadWrite.All'
    'AuditLog.Read.All'
    'CallRecords.Read.All'
    'Channel.Create'
    'Channel.Delete.All'
    'Channel.ReadBasic.All'
    'CloudPC.Read.All'
    'CloudPC.ReadWrite.All'
    'ConsentRequest.Read.All'
    'CustomAuthenticationExtension.Read.All'
    'CustomSecAttributeDefinition.Read.All'
    'Device.Read.All'
    'Device.ReadWrite.All'
    'DeviceManagementApps.Read.All'
    'DeviceManagementConfiguration.Read.All'
    'DeviceManagementConfiguration.ReadWrite.All'
    'DeviceManagementManagedDevices.PrivilegedOperations.All'
    'DeviceManagementManagedDevices.Read.All'
    'DeviceManagementManagedDevices.ReadWrite.All'
    'DeviceManagementRBAC.Read.All'
    'DeviceManagementServiceConfig.Read.All'
    'DeviceManagementServiceConfig.ReadWrite.All'
    'Directory.AccessAsUser.All'
    'Directory.Read.All'
    'Domain.Read.All'
    'Domain.ReadWrite.All'
    'eDiscovery.Read.All'
    'eDiscovery.ReadWrite.All'
    'EntitlementManagement.Read.All'
    'EntitlementManagement.ReadWrite.All'
    'Group.Read.All'
    'Group.ReadWrite.All'
    'GroupMember.Read.All'
    'GroupMember.ReadWrite.All'
    'IdentityProvider.Read.All'
    'IdentityRiskEvent.Read.All'
    'IdentityRiskyServicePrincipal.Read.All'
    'IdentityRiskyServicePrincipal.ReadWrite.All'
    'IdentityRiskyUser.Read.All'
    'IdentityRiskyUser.ReadWrite.All'
    'IdentityUserFlow.Read.All'
    'InformationProtectionPolicy.Read.All'
    'LifecycleWorkflows.Read.All'
    'LifecycleWorkflows.ReadWrite.All'
    'MailboxSettings.Read'
    'Organization.Read.All'
    'Policy.Read.All'
    'Policy.ReadWrite.AuthenticationMethod'
    'Policy.ReadWrite.ConditionalAccess'
    'Printer.Read.All'
    'PrintJob.ReadBasic.All'
    'PrivilegedAccess.Read.AzureADGroup'
    'PrivilegedAccess.ReadWrite.AzureADGroup'
    'RecordsManagement.Read.All'
    'Reports.Read.All'
    'RoleAssignmentSchedule.Read.Directory'
    'RoleAssignmentSchedule.ReadWrite.Directory'
    'RoleEligibilitySchedule.Read.Directory'
    'RoleEligibilitySchedule.ReadWrite.Directory'
    'RoleManagement.Read.Directory'
    'RoleManagement.ReadWrite.Directory'
    'RoleManagementPolicy.Read.Directory'
    'RoleManagementPolicy.ReadWrite.Directory'
    'SecurityAlert.Read.All'
    'SecurityAlert.ReadWrite.All'
    'SecurityEvents.Read.All'
    'SecurityIncident.Read.All'
    'SecurityIncident.ReadWrite.All'
    'ServiceHealth.Read.All'
    'ServiceMessage.Read.All'
    'SharePointTenantSettings.Read.All'
    'Sites.FullControl.All'
    'Sites.Read.All'
    'Sites.ReadWrite.All'
    'SubjectRightsRequest.Read.All'
    'Team.Create'
    'Team.ReadBasic.All'
    'Team.ReadWrite.All'
    'TeamMember.Read.All'
    'TeamMember.ReadWrite.All'
    'TeamsAppInstallation.ReadForTeam'
    'TeamworkAppSettings.Read.All'
    'TeamworkAppSettings.ReadWrite.All'
    'TeamworkDevice.Read.All'
    'ThreatAssessment.Read.All'
    'ThreatIntelligence.Read.All'
    'User.Invite.All'
    'User.Read.All'
    'User.ReadWrite.All'
    'UserAuthenticationMethod.Read.All'
    'UserAuthenticationMethod.ReadWrite.All'
)
Write-Host "`n$($delegatedPermissions.Count) permissions déléguées à accorder." -ForegroundColor Cyan

# ─── 4. Résolution des GUIDs depuis le SP Microsoft Graph ────────────────────
$graphSpAppId = '00000003-0000-0000-c000-000000000000'
Write-Host "Résolution des GUIDs depuis le SP Microsoft Graph..." -ForegroundColor Cyan

$graphSp = Get-MgServicePrincipal -Filter "appId eq '$graphSpAppId'" -Property "id,appId,oauth2PermissionScopes"
$graphSpObjectId = $graphSp.Id

$scopeMap = @{}
foreach ($scope in $graphSp.Oauth2PermissionScopes) {
    $scopeMap[$scope.Value] = $scope.Id
}

$resolvedScopes = [System.Collections.Generic.List[hashtable]]::new()
$missing = [System.Collections.Generic.List[string]]::new()

foreach ($perm in $delegatedPermissions) {
    if ($scopeMap.ContainsKey($perm)) {
        $resolvedScopes.Add(@{ id = $scopeMap[$perm].ToString(); type = 'Scope' })
    } else {
        $missing.Add($perm)
    }
}

if ($missing.Count -gt 0) {
    Write-Warning "$($missing.Count) permissions introuvables dans le SP Graph :"
    $missing | ForEach-Object { Write-Warning "  - $_" }
}
Write-Host "  $($resolvedScopes.Count)/$($delegatedPermissions.Count) GUIDs résolus." -ForegroundColor Green

# ─── 5. Récupérer l'inscription d'application ─────────────────────────────────
Write-Host "`nRécupération de l'inscription d'application $clientId..." -ForegroundColor Cyan
$app = Get-MgApplication -Filter "appId eq '$clientId'" -Property "id,appId,requiredResourceAccess"
$appObjectId = $app.Id

# Conserver les entrées existantes (permissions application actuelles)
$existingRRA = [System.Collections.Generic.List[object]]($app.RequiredResourceAccess)

# Trouver ou créer l'entrée pour Microsoft Graph
$graphEntry = $existingRRA | Where-Object { $_.ResourceAppId -eq $graphSpAppId }

$currentAccess = [System.Collections.Generic.List[Microsoft.Graph.PowerShell.Models.IMicrosoftGraphResourceAccess]]::new()
if ($graphEntry) {
    foreach ($ra in $graphEntry.ResourceAccess) { $currentAccess.Add($ra) }
}

$addedCount = 0
foreach ($scope in $resolvedScopes) {
    $alreadyPresent = $currentAccess | Where-Object {
        $_.Id -eq [System.Guid]$scope.id -and $_.Type -eq 'Scope'
    }
    if (-not $alreadyPresent) {
        $newAccess = [Microsoft.Graph.PowerShell.Models.MicrosoftGraphResourceAccess]@{
            Id   = $scope.id
            Type = 'Scope'
        }
        $currentAccess.Add($newAccess)
        $addedCount++
    }
}

Write-Host "  $addedCount nouvelles permissions déléguées ($($currentAccess.Count - $addedCount) déjà présentes)."

if ($WhatIf) {
    Write-Host "`n[WhatIf] Aucune modification appliquée." -ForegroundColor Yellow
    Write-Host "Permissions qui seraient ajoutées :"
    foreach ($scope in $resolvedScopes) {
        $name = ($scopeMap.GetEnumerator() | Where-Object { $_.Value -eq $scope.id }).Key
        Write-Host "  + $name  ($($scope.id))"
    }
    Disconnect-MgGraph | Out-Null
    exit 0
}

# ─── 6. Mettre à jour le requiredResourceAccess ───────────────────────────────
Write-Host "`nMise à jour du requiredResourceAccess..." -ForegroundColor Cyan

$newGraphEntry = [Microsoft.Graph.PowerShell.Models.MicrosoftGraphRequiredResourceAccess]@{
    ResourceAppId  = $graphSpAppId
    ResourceAccess = $currentAccess
}

$newRRA = [System.Collections.Generic.List[object]](
    @($existingRRA | Where-Object { $_.ResourceAppId -ne $graphSpAppId }) + @($newGraphEntry)
)

Update-MgApplication -ApplicationId $appObjectId -RequiredResourceAccess $newRRA
Write-Host "  requiredResourceAccess mis à jour." -ForegroundColor Green

# ─── 7. Récupérer le Service Principal de l'application ──────────────────────
Write-Host "`nRécupération du Service Principal..." -ForegroundColor Cyan
$appSp = Get-MgServicePrincipal -Filter "appId eq '$clientId'" -Property "id,appId"
$appSpObjectId = $appSp.Id
Write-Host "  SP Object ID : $appSpObjectId"

# ─── 8. Créer ou mettre à jour l'oauth2PermissionGrant ───────────────────────
Write-Host "`nCréation / mise à jour de l'admin consent (oauth2PermissionGrant)..." -ForegroundColor Cyan
$scopeString = $delegatedPermissions -join ' '

$existingGrant = Get-MgOauth2PermissionGrant -Filter "clientId eq '$appSpObjectId' and resourceId eq '$graphSpObjectId' and consentType eq 'AllPrincipals'" -ErrorAction SilentlyContinue

if ($existingGrant) {
    Write-Host "  Grant existant ($($existingGrant.Id)) — mise à jour des scopes..." -ForegroundColor Yellow
    Update-MgOauth2PermissionGrant -OAuth2PermissionGrantId $existingGrant.Id -Scope $scopeString
} else {
    Write-Host "  Création d'un nouveau grant AllPrincipals..." -ForegroundColor Yellow
    New-MgOauth2PermissionGrant `
        -ClientId    $appSpObjectId `
        -ConsentType 'AllPrincipals' `
        -ResourceId  $graphSpObjectId `
        -Scope       $scopeString | Out-Null
}
Write-Host "  Admin consent accordé pour $($delegatedPermissions.Count) permissions." -ForegroundColor Green

# ─── 9. Vérification ──────────────────────────────────────────────────────────
Write-Host "`nVérification..." -ForegroundColor Cyan
$verifyGrant = Get-MgOauth2PermissionGrant -Filter "clientId eq '$appSpObjectId' and resourceId eq '$graphSpObjectId'" -ErrorAction SilentlyContinue
if ($verifyGrant) {
    $grantedScopes = $verifyGrant.Scope -split ' '
    $missingScopes = @($delegatedPermissions | Where-Object { $_ -notin $grantedScopes })
    if ($missingScopes.Count -eq 0) {
        Write-Host "  Toutes les $($delegatedPermissions.Count) permissions confirmées dans le grant." -ForegroundColor Green
    } else {
        Write-Warning "  $($missingScopes.Count) permissions manquantes dans le grant :"
        $missingScopes | ForEach-Object { Write-Warning "    - $_" }
    }
}

Disconnect-MgGraph | Out-Null
Write-Host "`nCYSEC-1424 — Admin consent terminé. Prochaine étape : CYSEC-1425 (validation staging)." -ForegroundColor Green
