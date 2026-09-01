import type { ProviderConfig } from '../core/types'
import { getProviderStore } from '../stores/provider.store'
import { refreshClaudeTokens } from '../utils/claude-auth'

const REFRESH_WINDOW_MS = 5 * 60 * 1000
const refreshes = new Map<string, Promise<ProviderConfig>>()

/** Return a provider config with a usable Claude subscription access token. */
export async function ensureClaudeAccessToken(config: ProviderConfig): Promise<ProviderConfig> {
  if (config.protocol !== 'claude-subscription') return config

  const expiry = config.connection.token_expires_at
  if (config.connection.api_key && (!expiry || expiry > Date.now() + REFRESH_WINDOW_MS)) {
    return config
  }
  if (!config.connection.refresh_token) throw claudeReconnectError()

  const existing = refreshes.get(config.name)
  if (existing) return existing

  const task = refreshAndPersist(config).finally(() => refreshes.delete(config.name))
  refreshes.set(config.name, task)
  return task
}

async function refreshAndPersist(config: ProviderConfig): Promise<ProviderConfig> {
  let refreshed
  try {
    refreshed = await refreshClaudeTokens(config.connection.refresh_token!)
  } catch (cause) {
    const error = claudeReconnectError()
    ;(error as any).cause = cause
    throw error
  }

  const patch: Partial<ProviderConfig> = {
    connection: {
      ...config.connection,
      api_key: refreshed.access_token!,
      refresh_token: refreshed.refresh_token || config.connection.refresh_token,
      token_expires_at: Date.now() + (refreshed.expires_in || 3600) * 1000
    }
  }
  const updated = await getProviderStore().update(config.name, patch)
  if (!updated) throw new Error(`Provider not found: ${config.name}`)
  Object.assign(config.connection, updated.connection)
  return updated
}

function claudeReconnectError(): Error {
  const error: any = new Error('Claude session expired. Reconnect this provider from Provider Configuration.')
  error._providerError = true
  error._statusCode = 401
  error._errorBody = {
    message: error.message,
    type: 'authentication_error',
    code: 'claude_reconnect_required'
  }
  return error
}
