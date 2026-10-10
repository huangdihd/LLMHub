import type { ProviderManagement } from '../../server/core/registry'

export const management: ProviderManagement = {
  acceptsExtra: false,
  flatCreateCredentials: true,
  creationError: 'Use Connect Claude to add a Claude Subscription provider',
  protectedConnectionFields: ['api_key', 'refresh_token', 'id_token', 'device_id', 'account_id', 'project_id', 'account_email', 'base_url', 'token_expires_at']
}
