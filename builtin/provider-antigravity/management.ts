import type { ProviderManagement } from '../../server/core/registry'

export const management: ProviderManagement = {
  acceptsExtra: false,
  flatCreateCredentials: true,
  creationError: 'Use Connect Google to add an Antigravity Subscription provider',
  protectedConnectionFields: ['api_key', 'refresh_token', 'id_token', 'device_id', 'account_id', 'project_id', 'account_email', 'base_url', 'token_expires_at'],
  flatConnectionFields: {
    use_ai_credits_on_quota_exhausted: value => value === true
  }
}
