import type { ProviderConfig } from '../core/types'
import { getProviderStore } from '../stores/provider.store'
import {
  extractChatGptAccountId,
  extractJwtExpiry,
  refreshCodexTokens
} from '../utils/codex-auth'

const REFRESH_WINDOW_MS = 5 * 60 * 1000
const refreshes = new Map<string, Promise<ProviderConfig>>()

/** Return a provider config with a usable Codex access token, refreshing it when needed. */
export async function ensureCodexAccessToken(config: ProviderConfig): Promise<ProviderConfig> {
  if (config.protocol !== 'codex-subscription') return config

  const expiry = config.connection.token_expires_at
    || extractJwtExpiry(config.connection.api_key)
  if (config.connection.api_key && (!expiry || expiry > Date.now() + REFRESH_WINDOW_MS)) {
    return config
  }
  if (!config.connection.refresh_token) {
    throw codexReconnectError()
  }

  const existing = refreshes.get(config.name)
  if (existing) return existing

  const task = refreshAndPersist(config).finally(() => refreshes.delete(config.name))
  refreshes.set(config.name, task)
  return task
}

async function refreshAndPersist(config: ProviderConfig): Promise<ProviderConfig> {
  let refreshed
  try {
    refreshed = await refreshCodexTokens(config.connection.refresh_token!)
  } catch (cause) {
    const error = codexReconnectError()
    ;(error as any).cause = cause
    throw error
  }

  const accessToken = refreshed.access_token!
  const idToken = refreshed.id_token || config.connection.id_token
  const patch: Partial<ProviderConfig> = {
    connection: {
      ...config.connection,
      api_key: accessToken,
      refresh_token: refreshed.refresh_token || config.connection.refresh_token,
      id_token: idToken,
      token_expires_at: extractJwtExpiry(accessToken),
      account_id: extractChatGptAccountId(idToken)
        || extractChatGptAccountId(accessToken)
        || config.connection.account_id
    }
  }

  const updated = await getProviderStore().update(config.name, patch)
  if (!updated) throw new Error(`Provider not found: ${config.name}`)
  Object.assign(config.connection, updated.connection)
  return updated
}

function codexReconnectError(): Error {
  const error: any = new Error('ChatGPT session expired. Reconnect this provider from Provider Configuration.')
  error._providerError = true
  error._statusCode = 401
  error._errorBody = {
    message: error.message,
    type: 'authentication_error',
    code: 'codex_reconnect_required'
  }
  return error
}
