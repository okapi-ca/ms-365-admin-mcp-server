# CYSEC-1422 — Baseline des permissions Microsoft Graph

**Date:** 2026-04-21  
**Auteur:** Marc Bourget  
**Ticket:** CYSEC-1422 (Epic CYSEC-976)

---

## Contexte

Ce document établit le baseline des permissions Microsoft Graph requises par le serveur MCP
dans le cadre de la migration vers le flux OBO (On-Behalf-Of) délégué — CYSEC-1421.

L'objectif est de remplacer les 112 permissions _Application_ (app-only) par leurs équivalents
_Délégués_, de façon à ce que les appels Graph soient effectués sous l'identité de l'utilisateur
authentifié (via PKCE + OBO), et non sous le compte de service.

---

## Résumé

| Catégorie                                                           | Nombre |
| ------------------------------------------------------------------- | ------ |
| Permissions application actuelles                                   | 112    |
| Permissions déléguées résolues (admin consent accordé — CYSEC-1424) | 97     |
| Permissions sans équivalent délégué confirmé                        | 14     |
| Outils utilisant le chemin app-only hybride                         | 39     |

---

## Permissions sans équivalent délégué (exceptions app-only)

Ces permissions doivent conserver un chemin **app-only** dans l'implémentation hybride.
Les outils correspondants continueront d'utiliser `acquireTokenByClientCredential` même en
mode `--oauth-mode`. La liste a été confirmée lors du déploiement du consentement (CYSEC-1424) :
6 permissions supplémentaires étaient absentes de `oauth2PermissionScopes` du SP Graph.

| Permission                                | Outils (n) | Raison                                              |
| ----------------------------------------- | ---------- | --------------------------------------------------- |
| `BitlockerKey.Read.All`                   | 1          | Application-only par conception — clés BitLocker    |
| `DeviceLocalCredential.Read.All`          | 1          | Application-only par conception — LAPS credentials  |
| `OnPremDirectorySynchronization.Read.All` | 1          | Application-only par conception — sync AD Connect   |
| `Exchange.ManageAsApp`                    | 9          | Application-only — gestion Exchange Online via REST |
| `SecurityIdentitiesHealth.Read.All`       | 3          | Application-only — Defender for Identity (MDI)      |
| `ThreatHunting.Read.All`                  | 1          | Application-only — Advanced Hunting                 |
| `CopilotSettings-Internal.ReadWrite.All`  | 2          | Permission interne non documentée — app-only        |
| `PrintConnector.Read.All`                 | 1          | Application-only — Universal Print connector        |
| `CallRecords.Read.All`                    | 11         | Absent du SP Graph en délégué (CYSEC-1424)          |
| `AppRoleAssignment.Read.All`              | 1          | Absent du SP Graph en délégué (CYSEC-1424)          |
| `Device.ReadWrite.All`                    | 1          | Absent du SP Graph en délégué (CYSEC-1424)          |
| `InformationProtectionPolicy.Read.All`    | 5          | Absent du SP Graph en délégué (CYSEC-1424)          |
| `Team.ReadWrite.All`                      | 3          | Absent du SP Graph en délégué (CYSEC-1424)          |
| `ThreatAssessment.Read.All`               | 1          | Application-only confirmé                           |

> **Note** : `Application.ReadWrite.OwnedBy` a été remplacée par la permission déléguée
> `Application.ReadWrite.All` (déjà dans les 97 accordées).

### Détail des outils app-only

| Outil                            | Permission app-only                                           |
| -------------------------------- | ------------------------------------------------------------- |
| `list-bitlocker-recovery-keys`   | `BitlockerKey.Read.All`                                       |
| `list-device-local-credentials`  | `DeviceLocalCredential.Read.All`                              |
| `list-on-premises-sync`          | `OnPremDirectorySynchronization.Read.All`                     |
| `list-exchange-mailboxes`        | `Exchange.ManageAsApp`                                        |
| `get-exchange-mailbox`           | `Exchange.ManageAsApp`                                        |
| `list-exchange-mailbox-folders`  | `Exchange.ManageAsApp`                                        |
| `get-exchange-mailbox-folder`    | `Exchange.ManageAsApp`                                        |
| `export-exchange-mailbox-items`  | `Exchange.ManageAsApp`                                        |
| `update-exchange-mailbox`        | `Exchange.ManageAsApp`                                        |
| `delete-exchange-mailbox`        | `Exchange.ManageAsApp`                                        |
| `list-identity-health-issues`    | `SecurityIdentitiesHealth.Read.All`                           |
| `list-identity-sensors`          | `SecurityIdentitiesHealth.Read.All`                           |
| `get-identity-security-settings` | `SecurityIdentitiesHealth.Read.All`                           |
| `run-hunting-query`              | `ThreatHunting.Read.All`                                      |
| `add-application-password`       | `Application.ReadWrite.OwnedBy` → `Application.ReadWrite.All` |
| `remove-application-password`    | `Application.ReadWrite.OwnedBy` → `Application.ReadWrite.All` |
| `add-application-key`            | `Application.ReadWrite.OwnedBy` → `Application.ReadWrite.All` |
| `remove-application-key`         | `Application.ReadWrite.OwnedBy` → `Application.ReadWrite.All` |
| `get-copilot-admin-settings`     | `CopilotSettings-Internal.ReadWrite.All`                      |
| `get-copilot-limited-mode`       | `CopilotSettings-Internal.ReadWrite.All`                      |
| `list-print-connectors`          | `PrintConnector.Read.All`                                     |

> **Note CYSEC-1424**: Pour `Application.ReadWrite.OwnedBy`, la permission déléguée à
> accorder est `Application.ReadWrite.All` (scope plus large, mais c'est l'équivalent
> délégué disponible). Ces outils fonctionneront en OBO avec la permission déléguée.

---

## Liste complète des permissions déléguées à accorder (103)

Ces permissions doivent faire l'objet d'un **admin consent** dans l'inscription d'application
Entra (CYSEC-1424).

| Permission déléguée                                       | Outils (n) | Type d'opération                                |
| --------------------------------------------------------- | ---------- | ----------------------------------------------- |
| `AccessReview.Read.All`                                   | 6          | GET                                             |
| `AccessReview.ReadWrite.All`                              | 8          | POST/PUT/DELETE                                 |
| `AdministrativeUnit.Read.All`                             | 3          | GET                                             |
| `AdministrativeUnit.ReadWrite.All`                        | 4          | POST/PATCH/DELETE                               |
| `Agreement.Read.All`                                      | 3          | GET                                             |
| `APIConnectors.Read.All`                                  | 2          | GET                                             |
| `AppCatalog.Read.All`                                     | 3          | GET                                             |
| `Application.Read.All`                                    | 9          | GET                                             |
| `Application.ReadWrite.All`                               | 23         | PATCH/DELETE/POST (inclut les 4 outils OwnedBy) |
| `AppRoleAssignment.Read.All`                              | 1          | GET                                             |
| `AppRoleAssignment.ReadWrite.All`                         | 1          | POST                                            |
| `AttackSimulation.Read.All`                               | 8          | GET                                             |
| `AttackSimulation.ReadWrite.All`                          | 3          | POST/PATCH/DELETE                               |
| `AuditLog.Read.All`                                       | 3          | GET                                             |
| `CallRecords.Read.All`                                    | 11         | GET                                             |
| `Channel.Create`                                          | 1          | POST                                            |
| `Channel.Delete.All`                                      | 1          | DELETE                                          |
| `Channel.ReadBasic.All`                                   | 2          | GET                                             |
| `CloudPC.Read.All`                                        | 7          | GET                                             |
| `CloudPC.ReadWrite.All`                                   | 3          | POST/PATCH/DELETE                               |
| `ConsentRequest.Read.All`                                 | 3          | GET                                             |
| `CustomAuthenticationExtension.Read.All`                  | 2          | GET                                             |
| `CustomSecAttributeDefinition.Read.All`                   | 2          | GET                                             |
| `Device.Read.All`                                         | 2          | GET                                             |
| `Device.ReadWrite.All`                                    | 1          | PATCH                                           |
| `DeviceManagementApps.Read.All`                           | 17         | GET/POST                                        |
| `DeviceManagementConfiguration.Read.All`                  | 13         | GET/POST                                        |
| `DeviceManagementConfiguration.ReadWrite.All`             | 6          | POST/PATCH/DELETE                               |
| `DeviceManagementManagedDevices.PrivilegedOperations.All` | 16         | POST                                            |
| `DeviceManagementManagedDevices.Read.All`                 | 23         | GET/POST                                        |
| `DeviceManagementManagedDevices.ReadWrite.All`            | 1          | DELETE                                          |
| `DeviceManagementRBAC.Read.All`                           | 3          | GET                                             |
| `DeviceManagementServiceConfig.Read.All`                  | 14         | GET                                             |
| `DeviceManagementServiceConfig.ReadWrite.All`             | 6          | POST/PATCH/DELETE                               |
| `Directory.AccessAsUser.All`                              | 1          | POST                                            |
| `Directory.Read.All`                                      | 5          | GET                                             |
| `Domain.Read.All`                                         | 2          | GET                                             |
| `Domain.ReadWrite.All`                                    | 2          | POST                                            |
| `eDiscovery.Read.All`                                     | 4          | GET                                             |
| `eDiscovery.ReadWrite.All`                                | 9          | POST/PATCH/DELETE                               |
| `EntitlementManagement.Read.All`                          | 10         | GET                                             |
| `EntitlementManagement.ReadWrite.All`                     | 12         | POST/PATCH/DELETE/PUT                           |
| `Group.Read.All`                                          | 3          | GET                                             |
| `Group.ReadWrite.All`                                     | 4          | DELETE/POST/PATCH                               |
| `GroupMember.Read.All`                                    | 2          | GET                                             |
| `GroupMember.ReadWrite.All`                               | 1          | POST                                            |
| `IdentityProvider.Read.All`                               | 2          | GET                                             |
| `IdentityRiskEvent.Read.All`                              | 3          | GET                                             |
| `IdentityRiskyServicePrincipal.Read.All`                  | 2          | GET                                             |
| `IdentityRiskyServicePrincipal.ReadWrite.All`             | 2          | POST                                            |
| `IdentityRiskyUser.Read.All`                              | 3          | GET                                             |
| `IdentityRiskyUser.ReadWrite.All`                         | 3          | POST                                            |
| `IdentityUserFlow.Read.All`                               | 2          | GET                                             |
| `InformationProtectionPolicy.Read.All`                    | 5          | GET                                             |
| `LifecycleWorkflows.Read.All`                             | 7          | GET                                             |
| `LifecycleWorkflows.ReadWrite.All`                        | 8          | POST/PATCH/DELETE                               |
| `MailboxSettings.Read`                                    | 2          | GET                                             |
| `Organization.Read.All`                                   | 3          | GET                                             |
| `Policy.Read.All`                                         | 27         | GET                                             |
| `Policy.ReadWrite.AuthenticationMethod`                   | 3          | POST/PATCH/DELETE                               |
| `Policy.ReadWrite.ConditionalAccess`                      | 6          | POST/PATCH/DELETE                               |
| `Printer.Read.All`                                        | 1          | GET                                             |
| `PrintJob.ReadBasic.All`                                  | 4          | GET                                             |
| `PrivilegedAccess.Read.AzureADGroup`                      | 6          | GET                                             |
| `PrivilegedAccess.ReadWrite.AzureADGroup`                 | 4          | POST                                            |
| `RecordsManagement.Read.All`                              | 8          | GET                                             |
| `Reports.Read.All`                                        | 12         | GET                                             |
| `RoleAssignmentSchedule.Read.Directory`                   | 3          | GET                                             |
| `RoleAssignmentSchedule.ReadWrite.Directory`              | 2          | POST                                            |
| `RoleEligibilitySchedule.Read.Directory`                  | 3          | GET                                             |
| `RoleEligibilitySchedule.ReadWrite.Directory`             | 2          | POST                                            |
| `RoleManagement.Read.Directory`                           | 5          | GET                                             |
| `RoleManagement.ReadWrite.Directory`                      | 1          | POST                                            |
| `RoleManagementPolicy.Read.Directory`                     | 2          | GET                                             |
| `RoleManagementPolicy.ReadWrite.Directory`                | 2          | POST/PATCH                                      |
| `SecurityAlert.Read.All`                                  | 2          | GET                                             |
| `SecurityAlert.ReadWrite.All`                             | 2          | PATCH/POST                                      |
| `SecurityEvents.Read.All`                                 | 4          | GET                                             |
| `SecurityIncident.Read.All`                               | 2          | GET                                             |
| `SecurityIncident.ReadWrite.All`                          | 1          | PATCH                                           |
| `ServiceHealth.Read.All`                                  | 2          | GET                                             |
| `ServiceMessage.Read.All`                                 | 1          | GET                                             |
| `SharePointTenantSettings.Read.All`                       | 1          | GET                                             |
| `Sites.FullControl.All`                                   | 5          | GET/POST/PATCH/DELETE                           |
| `Sites.Read.All`                                          | 12         | GET                                             |
| `Sites.ReadWrite.All`                                     | 7          | PATCH/POST/DELETE                               |
| `SubjectRightsRequest.Read.All`                           | 1          | GET                                             |
| `Team.Create`                                             | 2          | POST                                            |
| `Team.ReadBasic.All`                                      | 4          | GET                                             |
| `Team.ReadWrite.All`                                      | 3          | PATCH/POST                                      |
| `TeamMember.Read.All`                                     | 2          | GET                                             |
| `TeamMember.ReadWrite.All`                                | 2          | POST                                            |
| `TeamsAppInstallation.ReadForTeam`                        | 2          | GET                                             |
| `TeamworkAppSettings.Read.All`                            | 1          | GET                                             |
| `TeamworkAppSettings.ReadWrite.All`                       | 1          | PATCH                                           |
| `TeamworkDevice.Read.All`                                 | 5          | GET                                             |
| `ThreatAssessment.Read.All`                               | 1          | GET                                             |
| `ThreatIntelligence.Read.All`                             | 22         | GET                                             |
| `User.Invite.All`                                         | 2          | GET/POST                                        |
| `User.Read.All`                                           | 3          | GET                                             |
| `User.ReadWrite.All`                                      | 6          | PATCH/POST/DELETE                               |
| `UserAuthenticationMethod.Read.All`                       | 2          | GET                                             |
| `UserAuthenticationMethod.ReadWrite.All`                  | 1          | DELETE                                          |

---

## Impact sur l'inscription d'application (CYSEC-1424)

### Opérations requises dans l'inscription `ms365admin-app` (ID: `86f46c1e-…`)

1. **Ajouter** les 103 permissions déléguées ci-dessus (API: Microsoft Graph)
2. **Admin consent** sur toutes ces permissions déléguées
3. **Conserver** les permissions application existantes le temps de la phase de transition
4. **Révoquer** les 112 permissions application lors de la bascule production (CYSEC-1426)

### Permissions application à conserver de façon permanente

Ces 9 permissions doivent rester en mode application même après la bascule OBO complète :

- `BitlockerKey.Read.All`
- `DeviceLocalCredential.Read.All`
- `OnPremDirectorySynchronization.Read.All`
- `Exchange.ManageAsApp`
- `SecurityIdentitiesHealth.Read.All`
- `ThreatHunting.Read.All`
- `CopilotSettings-Internal.ReadWrite.All`
- `PrintConnector.Read.All`

`Application.ReadWrite.OwnedBy` peut être remplacée par la permission déléguée
`Application.ReadWrite.All` (déjà dans la liste déléguée).

---

## Travaux dérivés (CYSEC-1423 — implémentation code)

Le chemin hybride (app-only pour les 21 outils exceptions) n'est **pas encore implémenté**
dans le code. Actuellement, en mode `--oauth-mode`, TOUS les appels passent par OBO — ce qui
fera échouer les 21 outils app-only avec une erreur 403 de Graph.

**Travail requis (scope CYSEC-1423 sprint 2):**

- Ajouter un champ `appOnlyPermissions: string[]` dans `endpoints.json` pour les outils exceptions
- Dans `createServer()`, passer les deux getters (`getToken` + `getOBOToken`) à `registerGraphTools`
- `registerGraphTools` choisit le getter selon le type de permission de chaque outil
- Alternative plus simple: liste statique des `toolName` app-only dans `server.ts`
