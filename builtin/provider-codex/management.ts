import type { ProviderManagement } from '../../server/core/registry'

export const management: ProviderManagement = {
  acceptsExtra: false,
  flatCreateCredentials: true,
  creationError: 'Use Connect ChatGPT to add a Codex Subscription provider',
  protectedConnectionFields: ['api_key', 'refresh_token', 'id_token', 'device_id', 'account_id', 'project_id', 'account_email', 'base_url', 'token_expires_at'],
  flatConnectionFields: {
    client_version: value => String(value).trim().slice(0, 64),
    auto_reset_on_quota_exhausted: value => value === true
  }
}
