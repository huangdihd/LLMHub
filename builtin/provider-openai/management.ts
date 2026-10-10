import type { ProviderManagement } from '../../server/core/registry'

export const management: ProviderManagement = {
  acceptsExtra: false,
  flatCreateCredentials: true,
  createConnectionDefaults: { api_type: 'responses' }
}
