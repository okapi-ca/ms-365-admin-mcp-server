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

@description('Container App max replicas')
@minValue(1)
param maxReplicas int = 3

@description('Tags applied to every resource (must satisfy org tag policies)')
param tags object = {}

@description('Comma-separated Entra app IDs allowed to call the MCP server (required for HTTP transport)')
param allowedClients string

@description('Optional Azure Container Registry login server (e.g., myacr.azurecr.io). Leave empty for public images (ghcr, mcr).')
param acrLoginServer string = ''

var uamiName = '${baseName}-uami'
var kvName = take('${replace(baseName, '-', '')}kv${uniqueString(resourceGroup().id)}', 24)
var lawName = '${baseName}-law'
var appInsightsName = '${baseName}-ai'
var caeName = '${baseName}-cae'
var appName = '${baseName}-app'

var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var kvSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

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
  }
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
          args: [
            '--transport'
            'http'
            '--port'
            '8080'
            '--host'
            '0.0.0.0'
            '--allowed-clients'
            allowedClients
          ]
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
output uamiPrincipalId string = uami.properties.principalId
output uamiClientId string = uami.properties.clientId
