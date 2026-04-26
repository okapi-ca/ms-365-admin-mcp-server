// Azure Container Apps deployment for ms-365-admin-mcp-server.
// Secrets live in Key Vault (RBAC + purge protection). The Container App reads them
// via a user-assigned managed identity, using the Key Vault provider in src/secrets.ts.
//
// After deploy, seed the vault with:
//   az keyvault secret set --vault-name <kv> --name ms365-admin-mcp-client-id     --value <...>
//   az keyvault secret set --vault-name <kv> --name ms365-admin-mcp-tenant-id     --value <...>
//   az keyvault secret set --vault-name <kv> --name ms365-admin-mcp-client-secret --value <...>
//
// Graph API application permissions must be granted to the app registration whose
// clientId is stored in Key Vault (this template does not touch Entra ID).

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Base name used as prefix for all resources (lowercase, 3-20 chars)')
@minLength(3)
@maxLength(20)
param baseName string

@description('Container image to deploy')
param containerImage string

@description('Object IDs granted Key Vault Secrets Officer (for seeding/rotating secrets)')
param kvAdminObjectIds array = []

@description('Log Analytics retention in days')
param logRetentionDays int = 30

@description('Container App min replicas (0 enables scale-to-zero)')
@minValue(0)
param minReplicas int = 0

@description('Container App max replicas. SEC-F05: PKCE bridge is now externalised to Azure Table Storage (see storageAccount below), so this can safely scale past 1.')
@minValue(1)
param maxReplicas int = 3

@description('Tags applied to every resource (must satisfy org tag policies)')
param tags object = {}

@description('Comma-separated Entra app IDs allowed to call the MCP server via service-to-service tokens. Leave empty when only --oauth-mode is used.')
param allowedClients string = ''

@description('Enable OAuth proxy endpoints (DCR, /authorize, /token) for human-user clients (Claude Desktop/Code/Web).')
param oauthMode bool = false

@description('Comma-separated Entra user object IDs (oid) authorized to authenticate via OAuth. Required when oauthMode=true.')
param authorizedUsers string = ''

@description('Public URL that browsers reach the server at (used in OAuth metadata issuer). Leave empty to let the server derive it from request headers.')
param publicUrl string = ''

@description('Optional Azure Container Registry login server (e.g., myacr.azurecr.io). Leave empty for public images (ghcr, mcr).')
param acrLoginServer string = ''

// --- VNet integration parameters ---
//
// When vnetIntegrated=true: deploys a workload-profiles Container Apps Environment
// into a pre-existing infrastructure subnet (delegated to Microsoft.App/environments).
// The CAE is internal-only — clients reach /mcp from inside the VNet (or from a peered
// VNet, e.g. via VPN gateway). No public ingress, no Private Endpoint needed.
// The hub VNet + subnet must be pre-created by the network team.

@description('Integrate the Container Apps Environment with a pre-existing hub VNet (workload-profiles SKU + internal ingress). Requires hubSubscriptionId, hubVnetRg, hubVnetName, infrastructureSubnetName.')
param vnetIntegrated bool = false

@description('Subscription ID hosting the hub VNet. Required when vnetIntegrated=true.')
param hubSubscriptionId string = ''

@description('Resource group of the hub VNet. Required when vnetIntegrated=true.')
param hubVnetRg string = ''

@description('Hub VNet name. Required when vnetIntegrated=true.')
param hubVnetName string = ''

@description('Subnet in the hub VNet pre-delegated to Microsoft.App/environments, used as CAE infrastructure subnet. Required when vnetIntegrated=true.')
param infrastructureSubnetName string = ''

// --- Storage network access (SEC-008) ---
//
// SEC-008: when true, the Storage Account that backs the OAuth PKCE bridge and
// DCR client credentials switches its network ACL default to 'Deny'. The
// Container App's user-assigned managed identity continues to access the
// Storage Tables through the 'AzureServices' bypass — no functional change as
// long as the deployment stays in the same Azure tenant. Recommended for any
// regulated-tenant deployment (PIPEDA, RGPD, Loi 25, etc.) where audit
// frameworks require explicit network-level isolation in addition to the
// existing identity-based controls (allowSharedKeyAccess: false).
// Default false to preserve backward compatibility; set true on new and
// regulated deployments.

@description('SEC-008: switch Storage networkAcls.defaultAction to Deny (recommended for regulated tenants). The Container App UAMI still reaches Storage Tables via the AzureServices bypass + Azure AD trust within the same tenant.')
param restrictStorageNetworkAccess bool = false

// --- Resource name overrides ---
//
// Every Azure resource has a default name derived from baseName. Operators with strict
// naming conventions (e.g. Azure CAF or org-specific rules) can override each name via
// a parameters file. Leave empty to use the default.

@description('Container Apps Environment name. If empty, derived from baseName.')
param containerAppEnvName string = ''

@description('Container App name. If empty, derived from baseName.')
param containerAppName string = ''

@description('User-Assigned Managed Identity name. If empty, derived from baseName.')
param uamiName string = ''

@description('Key Vault name (must be globally unique, 3-24 chars, lowercase+numbers+hyphens). If empty, derived from baseName + uniqueString.')
param keyVaultName string = ''

@description('Storage Account name (must be globally unique, 3-24 chars, lowercase+numbers only). If empty, derived from baseName + uniqueString.')
param storageAccountName string = ''

@description('Log Analytics Workspace name. If empty, derived from baseName.')
param logAnalyticsWorkspaceName string = ''

@description('Application Insights name. If empty, derived from baseName.')
param appInsightsName string = ''

var effectiveUamiName = empty(uamiName) ? '${baseName}-uami' : uamiName
var effectiveKeyVaultName = empty(keyVaultName) ? take('${replace(baseName, '-', '')}kv${uniqueString(resourceGroup().id)}', 24) : keyVaultName
var effectiveLawName = empty(logAnalyticsWorkspaceName) ? '${baseName}-law' : logAnalyticsWorkspaceName
var effectiveAppInsightsName = empty(appInsightsName) ? '${baseName}-ai' : appInsightsName
var effectiveCaeName = empty(containerAppEnvName) ? '${baseName}-cae' : containerAppEnvName
var effectiveAppName = empty(containerAppName) ? '${baseName}-app' : containerAppName
var effectiveStorageAccountName = empty(storageAccountName) ? take('${replace(baseName, '-', '')}st${uniqueString(resourceGroup().id)}', 24) : storageAccountName
var oauthTableName = 'oauthstate'

var infrastructureSubnetId = vnetIntegrated ? resourceId(hubSubscriptionId, hubVnetRg, 'Microsoft.Network/virtualNetworks/subnets', hubVnetName, infrastructureSubnetName) : ''

var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var kvSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
var storageTableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

var baseArgs = [
  '--transport'
  'http'
  '--port'
  '8080'
  '--host'
  '0.0.0.0'
]
var serviceAuthArgs = empty(allowedClients) ? [] : [
  '--allowed-clients'
  allowedClients
]
var oauthArgs = oauthMode ? [
  '--oauth-mode'
] : []
var publicUrlArgs = (oauthMode && !empty(publicUrl)) ? [
  '--public-url'
  publicUrl
] : []
var authorizedUserArgs = (oauthMode && !empty(authorizedUsers)) ? [
  '--authorized-users'
  authorizedUsers
] : []
var containerArgs = concat(baseArgs, serviceAuthArgs, oauthArgs, publicUrlArgs, authorizedUserArgs)

// --- User-Assigned Managed Identity ---

resource uami 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: effectiveUamiName
  location: location
  tags: tags
}

// --- Key Vault (RBAC, purge protection, 90-day soft-delete) ---

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: effectiveKeyVaultName
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

resource uamiKvAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, uami.id, kvSecretsUserRoleId)
  properties: {
    principalId: uami.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      kvSecretsUserRoleId
    )
  }
}

resource kvAdmins 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for oid in kvAdminObjectIds: {
    scope: keyVault
    name: guid(keyVault.id, oid, kvSecretsOfficerRoleId)
    properties: {
      principalId: oid
      principalType: 'User'
      roleDefinitionId: subscriptionResourceId(
        'Microsoft.Authorization/roleDefinitions',
        kvSecretsOfficerRoleId
      )
    }
  }
]

// --- Storage Account (OAuth PKCE bridge + DCR client credentials, SEC-F04b / SEC-F05) ---

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: effectiveStorageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    defaultToOAuthAuthentication: true
    networkAcls: {
      // SEC-008: Deny + AzureServices bypass keeps the Storage Tables
      // unreachable from the public internet while the Container App's UAMI
      // (a trusted Azure service authenticated via Azure AD in the same
      // tenant) continues to read/write the OAuth state. Set
      // restrictStorageNetworkAccess=true on regulated-tenant deployments.
      defaultAction: restrictStorageNetworkAccess ? 'Deny' : 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

resource oauthTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: oauthTableName
}

resource uamiTableAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storageAccount
  name: guid(storageAccount.id, uami.id, storageTableDataContributorRoleId)
  properties: {
    principalId: uami.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      storageTableDataContributorRoleId
    )
  }
}

// --- Log Analytics + Application Insights ---

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: effectiveLawName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logRetentionDays
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: effectiveAppInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

// --- Container App Environment ---

resource containerAppEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: effectiveCaeName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    workloadProfiles: vnetIntegrated ? [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ] : null
    vnetConfiguration: vnetIntegrated ? {
      infrastructureSubnetId: infrastructureSubnetId
      internal: true
    } : null
  }
}

// --- Container App ---

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: effectiveAppName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uami.id}': {}
    }
  }
  dependsOn: [
    uamiKvAccess
    uamiTableAccess
  ]
  properties: {
    managedEnvironmentId: containerAppEnv.id
    workloadProfileName: vnetIntegrated ? 'Consumption' : null
    configuration: {
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
      }
      registries: empty(acrLoginServer) ? [] : [
        {
          server: acrLoginServer
          identity: uami.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'mcp-admin'
          image: containerImage
          command: [
            'node'
            'dist/index.js'
          ]
          args: containerArgs
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'MS365_ADMIN_MCP_KEYVAULT_URL'
              value: keyVault.properties.vaultUri
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: uami.properties.clientId
            }
            {
              name: 'MS365_ADMIN_MCP_LOG_DIR'
              value: '/tmp/ms365-admin-mcp/logs'
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: appInsights.properties.ConnectionString
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT_NAME'
              value: storageAccount.name
            }
            {
              name: 'AZURE_STORAGE_TABLE_NAME'
              value: oauthTableName
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output containerAppUrl string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output containerAppEnvDefaultDomain string = containerAppEnv.properties.defaultDomain
output keyVaultName string = keyVault.name
output storageAccountName string = storageAccount.name
output uamiPrincipalId string = uami.properties.principalId
output uamiClientId string = uami.properties.clientId
output vnetIntegrated bool = vnetIntegrated
output infrastructureSubnetId string = infrastructureSubnetId

// SEC-008: surface the deployment's security posture so operators can audit
// it via `az deployment group show` without re-reading the parameters file.
// Regulated-tenant baseline: vnetIntegrated=true AND restrictStorageNetworkAccess=true.
output securityPosture object = {
  vnetIntegrated: vnetIntegrated
  restrictStorageNetworkAccess: restrictStorageNetworkAccess
  storageNetworkDefaultAction: restrictStorageNetworkAccess ? 'Deny' : 'Allow'
  oauthMode: oauthMode
  regulatedTenantBaseline: vnetIntegrated && restrictStorageNetworkAccess
}
