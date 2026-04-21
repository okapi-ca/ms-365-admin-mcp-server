// Private DNS zone + VNet link, deployed into a centralized DNS resource group.
// Called as a cross-RG module from main.bicep when enablePrivateEndpoint=true.

targetScope = 'resourceGroup'

@description('Private DNS zone name (e.g. privatelink.<region>.azurecontainerapps.io)')
param zoneName string

@description('Resource ID of the virtual network to link to the zone')
param virtualNetworkId string

@description('Tags applied to the zone and link')
param tags object = {}

resource zone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: zoneName
  location: 'global'
  tags: tags
  properties: {}
}

resource vnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: zone
  name: uniqueString(virtualNetworkId)
  location: 'global'
  tags: tags
  properties: {
    virtualNetwork: {
      id: virtualNetworkId
    }
    registrationEnabled: false
  }
}

output zoneId string = zone.id
