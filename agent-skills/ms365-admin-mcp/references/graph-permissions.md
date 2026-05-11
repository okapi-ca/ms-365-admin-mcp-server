# Graph API permissions

Reference list of Microsoft Graph **application** permissions (client credentials) consumed by `ms-365-admin-mcp-server`. Match these to the app registration backing your deployment.

For the canonical list as exposed by a running server:

```bash
node dist/index.js --list-permissions
```

For setup instructions (admin consent, redirect URIs, etc.), see [`docs/APP_REGISTRATION.md`](../../../docs/APP_REGISTRATION.md).

## Read-only permissions (default)

```
AccessReview.Read.All
AdministrativeUnit.Read.All
Agreement.Read.All
APIConnectors.Read.All
AppCatalog.Read.All
Application.Read.All
AppRoleAssignment.Read.All
AttackSimulation.Read.All
AuditLog.Read.All
BitlockerKey.Read.All
CallRecords.Read.All
Channel.ReadBasic.All
CloudPC.Read.All
ConsentRequest.Read.All
CopilotSettings-Internal.ReadWrite.All
CustomAuthenticationExtension.Read.All
CustomSecAttributeDefinition.Read.All
Device.Read.All
DeviceLocalCredential.Read.All
DeviceManagementApps.Read.All
DeviceManagementConfiguration.Read.All
DeviceManagementManagedDevices.Read.All
DeviceManagementRBAC.Read.All
DeviceManagementServiceConfig.Read.All
Directory.Read.All
Domain.Read.All
eDiscovery.Read.All
EntitlementManagement.Read.All
Exchange.ManageAsApp
Group.Read.All
GroupMember.Read.All
IdentityProvider.Read.All
IdentityRiskEvent.Read.All
IdentityRiskyServicePrincipal.Read.All
IdentityRiskyUser.Read.All
IdentityUserFlow.Read.All
InformationProtectionPolicy.Read.All
LifecycleWorkflows.Read.All
MailboxSettings.Read
OnPremDirectorySynchronization.Read.All
Organization.Read.All
Policy.Read.All
Printer.Read.All
PrintConnector.Read.All
PrintJob.Read.All
PrivilegedAccess.Read.AzureADGroup
RecordsManagement.Read.All
Reports.Read.All
RoleAssignmentSchedule.Read.Directory
RoleEligibilitySchedule.Read.Directory
RoleManagement.Read.Directory
RoleManagementPolicy.Read.Directory
SecurityAlert.Read.All
SecurityEvents.Read.All
SecurityIdentitiesHealth.Read.All
SecurityIncident.Read.All
ServiceHealth.Read.All
ServiceMessage.Read.All
SharePointTenantSettings.Read.All
Sites.Read.All
Sites.FullControl.All
SubjectRightsRequest.Read.All
Team.ReadBasic.All
TeamMember.Read.All
TeamsAppInstallation.ReadForTeam.All
TeamworkAppSettings.Read.All
TeamworkDevice.Read.All
ThreatAssessment.Read.All
ThreatHunting.Read.All
ThreatIntelligence.Read.All
User.Invite.All
User.Read.All
UserAuthenticationMethod.Read.All
```

## Write permissions (incident response, device actions, CA, Teams, SharePoint, identity management)

Required only when the server is started with `--allow-writes`.

```
AccessReview.ReadWrite.All
AdministrativeUnit.ReadWrite.All
Application.ReadWrite.All
Application.ReadWrite.OwnedBy
AppRoleAssignment.ReadWrite.All
AttackSimulation.ReadWrite.All
Channel.Create
Channel.Delete.All
CloudPC.ReadWrite.All
Device.ReadWrite.All
DeviceManagementConfiguration.ReadWrite.All
DeviceManagementManagedDevices.PrivilegedOperations.All
DeviceManagementManagedDevices.ReadWrite.All
DeviceManagementServiceConfig.ReadWrite.All
Directory.AccessAsUser.All
Domain.ReadWrite.All
eDiscovery.ReadWrite.All
EntitlementManagement.ReadWrite.All
Group.ReadWrite.All
GroupMember.ReadWrite.All
IdentityRiskyServicePrincipal.ReadWrite.All
IdentityRiskyUser.ReadWrite.All
LifecycleWorkflows.ReadWrite.All
Policy.ReadWrite.AuthenticationMethod
Policy.ReadWrite.ConditionalAccess
PrivilegedAccess.ReadWrite.AzureADGroup
RoleAssignmentSchedule.ReadWrite.Directory
RoleEligibilitySchedule.ReadWrite.Directory
RoleManagement.ReadWrite.Directory
RoleManagementPolicy.ReadWrite.Directory
SecurityAlert.ReadWrite.All
SecurityIncident.ReadWrite.All
Sites.ReadWrite.All
Team.Create
Team.ReadWrite.All
TeamMember.ReadWrite.All
TeamworkAppSettings.ReadWrite.All
User.ReadWrite.All
UserAuthenticationMethod.ReadWrite.All
```

## Verifying consent

On the Microsoft Entra portal:

1. Entra → App registrations → select the app backing your server.
2. API permissions → Configured permissions.
3. Confirm "Granted for `<tenant>`" status for each permission used.

When an MCP call returns **403 Forbidden** or `Insufficient privileges`:

1. Identify the required `Application` permission from the Microsoft Graph documentation for that endpoint.
2. Verify whether it is listed and consented on the app registration.
3. If missing, consent it (Application Administrator or Privileged Role Administrator).

## Notes on scope

- All permissions here are **application-level** (client credentials), not delegated.
- `Sites.FullControl.All` is very broad — it backs the SharePoint admin tools. Restrict the app to the sites it needs via SharePoint sites.selected if your tenant requires least-privilege scoping.
- `Directory.AccessAsUser.All` is the most sensitive — it is functionally equivalent to a tenant admin operating through Graph. Treat the app registration accordingly (Key Vault for secrets, federated credentials in Azure, Conditional Access restricting where the SP can sign in, regular sign-in log review).

## Operator hardening checklist

The app registration backing this server is, in practice, a high-privilege identity. At minimum:

- Store the client secret in a secrets manager (Azure Key Vault, AWS Secrets Manager, 1Password, etc.), never in code or environment files committed to a repo.
- Rotate the secret at least every 12 months. Prefer federated credentials (workload identity federation) when the server runs in Azure / GitHub Actions.
- Limit the application's owners list. Audit periodically.
- Apply Conditional Access to the application's service principal if your tenant supports it (geofencing, sign-in risk).
- Monitor `list-sign-ins` filtered on the SP's `appId` for anomalies.

See also: [`SECURITY.md`](../../../SECURITY.md) and [`docs/AZURE_DEPLOYMENT_SECURITY.md`](../../../docs/AZURE_DEPLOYMENT_SECURITY.md).
