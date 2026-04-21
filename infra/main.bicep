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

// --- Private endpoint parameters ---
//
// When true: adds a Private Endpoint on the Container Apps Environment via an external
// hub VNet, wires it to a centralized Private DNS zone, and disables public ingress on
// the CAE. All hub-specific values (subscription, VNet, subnet, DNS RG) must be supplied
// via a parameters file — see infra/parameters.example.jsonc.

@description('Add a Private Endpoint on the Container Apps Environment and disable public ingress. Requires a hub VNet + pre-created subnet + centralized DNS zone.')
param enablePrivateEndpoint bool = false

@description('Subscription ID hosting the hub VNet and centralized Private DNS zones. Required when enablePrivateEndpoint=true.')
param hubSubscriptionId string = ''

@description('Resource group of the hub VNet. Required when enablePrivateEndpoint=true.')
param hubVnetRg string = ''

@description('Hub VNet name. Required when enablePrivateEndpoint=true.')
param hubVnetName string = ''

@description('Subnet name in the hub VNet hosting the Private Endpoint NIC (must be pre-created by infra team). Required when enablePrivateEndpoint=true.')
param peSubnetName string = ''

@description('Resource group hosting the centralized Private DNS zones. Required when enablePrivateEndpoint=true.')
param privateDnsZoneRg string = ''

@description('Region for the Private Endpoint NIC (may differ from CAE region). Required when enablePrivateEndpoint=true.')
param privateEndpointLocation string = ''

@description('Private Endpoint resource name. If empty, derived from baseName.')
param privateEndpointName string = ''

@description('Application Security Group name attached to the Private Endpoint NIC. If empty, derived from baseName.')
param applicationSecurityGroupName string = ''

var uamiName = '${baseName}-uami'
var kvName = take('${replace(baseName, '-', '')}kv${uniqueString(resourceGroup().id)}', 24)
var lawName = '${baseName}-law'
var appInsightsName = '${baseName}-ai'
var caeName = '${baseName}-cae'
var appName = '${baseName}-app'
var storageAccountName = take('${replace(baseName, '-', '')}st${uniqueString(resourceGroup().id)}', 24)
var oauthTableName = 'oauthstate'

var peName = empty(privateEndpointName) ? '${baseName}-cae-pe' : privateEndpointName
var asgName = empty(applicationSecurityGroupName) ? '${baseName}-pe-asg' : applicationSecurityGroupName
var caeDnsZoneName = 'privatelink.${location}.azurecontainerapps.io'
var hubVnetId = enablePrivateEndpoint ? resourceId(hubSubscriptionId, hubVnetRg, 'Microsoft.Network/virtualNetworks', hubVnetName) : ''
var peSubnetId = enablePrivateEndpoint ? '${hubVnetId}/subnets/${peSubnetName}' : ''

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
  name: uamiName
  location: location
  tags: tags
}

// --- Key Vault (RBAC, purge protection, 90-day soft-delete) ---

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
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
  name: storageAccountName
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
      defaultAction: 'Allow'
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
  name: lawName
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
  name: appInsightsName
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
  name: caeName
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
    publicNetworkAccess: enablePrivateEndpoint ? 'Disabled' : 'Enabled'
  }
}

// --- Private Endpoint on Container Apps Environment ---
//
// Deploys PE + ASG in this RG, plus DNS zone + VNet link in the centralized DNS RG.
// All hub-specific IDs arrive via parameters (see infra/parameters.example.jsonc).

resource asg 'Microsoft.Network/applicationSecurityGroups@2023-09-01' = if (enablePrivateEndpoint) {
  name: asgName
  location: privateEndpointLocation
  tags: tags
  properties: {}
}

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (enablePrivateEndpoint) {
  name: peName
  location: privateEndpointLocation
  tags: tags
  properties: {
    subnet: {
      id: peSubnetId
    }
    customNetworkInterfaceName: '${peName}-nic'
    privateLinkServiceConnections: [
      {
        name: peName
        properties: {
          privateLinkServiceId: containerAppEnv.id
          groupIds: [
            'managedEnvironments'
          ]
        }
      }
    ]
    applicationSecurityGroups: [
      {
        id: asg.id
      }
    ]
  }
}

module privateDnsZone 'modules/private-dns.bicep' = if (enablePrivateEndpoint) {
  name: 'private-dns-${uniqueString(resourceGroup().id, caeName)}'
  scope: resourceGroup(hubSubscriptionId, privateDnsZoneRg)
  params: {
    zoneName: caeDnsZoneName
    virtualNetworkId: hubVnetId
    tags: tags
  }
}

resource dnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-09-01' = if (enablePrivateEndpoint) {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: replace(caeDnsZoneName, '.', '-')
        properties: {
          privateDnsZoneId: resourceId(hubSubscriptionId, privateDnsZoneRg, 'Microsoft.Network/privateDnsZones', caeDnsZoneName)
        }
      }
    ]
  }
  dependsOn: [
    privateDnsZone
  ]
}

// --- Container App ---

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
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
output keyVaultName string = keyVault.name
output storageAccountName string = storageAccount.name
output uamiPrincipalId string = uami.properties.principalId
output uamiClientId string = uami.properties.clientId
output privateEndpointEnabled bool = enablePrivateEndpoint
output privateEndpointName string = enablePrivateEndpoint ? privateEndpoint.name : ''
output privateDnsZoneName string = enablePrivateEndpoint ? caeDnsZoneName : ''
