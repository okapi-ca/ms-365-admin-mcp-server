// Azure Container Apps deployment for ms-365-admin-mcp-server
// Skeleton template — fill in parameters and role assignments before deploying.

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Container image to deploy')
param containerImage string

@description('Azure AD tenant ID for Graph API auth')
@secure()
param tenantId string

@description('App registration client ID')
@secure()
param clientId string

@description('App registration client secret')
@secure()
param clientSecret string

// --- Log Analytics Workspace ---

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'law-mcp-admin'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// --- Application Insights ---

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'ai-mcp-admin'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

// --- Container App Environment ---

resource containerAppEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-mcp-admin'
  location: location
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
  name: 'ca-mcp-admin'
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
      }
      secrets: [
        { name: 'client-id', value: clientId }
        { name: 'client-secret', value: clientSecret }
        { name: 'tenant-id', value: tenantId }
      ]
    }
    template: {
      containers: [
        {
          name: 'mcp-admin'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'MS365_ADMIN_MCP_CLIENT_ID', secretRef: 'client-id' }
            { name: 'MS365_ADMIN_MCP_CLIENT_SECRET', secretRef: 'client-secret' }
            { name: 'MS365_ADMIN_MCP_TENANT_ID', secretRef: 'tenant-id' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 3
      }
    }
  }
}

// TODO: Add role assignments for the system-assigned managed identity
// - Microsoft Graph API permissions cannot be assigned via Bicep directly
// - Use a post-deployment script with az ad app permission grant
// - Or use Azure CLI: az role assignment create --assignee <principalId> ...

output containerAppUrl string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output principalId string = containerApp.identity.principalId
