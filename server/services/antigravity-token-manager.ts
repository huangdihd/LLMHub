import type { ProviderConfig } from '../core/types'
import { getProviderStore } from '../stores/provider.store'
import { discoverAntigravityAccount, refreshAntigravityTokens } from '../utils/antigravity-auth'

const REFRESH_WINDOW_MS = 5 * 60 * 1000
const refreshes = new Map<string, Promise<ProviderConfig>>()

/** Return a provider config with a usable Google OAuth token and Antigravity project. */
export async function ensureAntigravityAccessToken(config: ProviderConfig): Promise<ProviderConfig> {
  if (config.protocol !== 'antigravity-subscription') return config

  const needsRefresh = !config.connection.api_key
    || !config.connection.token_expires_at
    || config.connection.token_expires_at <= Date.now() + REFRESH_WINDOW_MS
  if (!needsRefresh && config.connection.project_id) return config
  if (!config.connection.refresh_token && needsRefresh) throw antigravityReconnectError()

  const existing = refreshes.get(config.name)
  if (existing) return existing
  const task = refreshAndPersist(config, needsRefresh).finally(() => refreshes.delete(config.name))
  refreshes.set(config.name, task)
  return task
}

async function refreshAndPersist(config: ProviderConfig, refresh: boolean): Promise<ProviderConfig> {
  let accessToken = config.connection.api_key
  let refreshToken = config.connection.refresh_token
  let expiresAt = config.connection.token_expires_at

  if (refresh) {
    try {
      const tokens = await refreshAntigravityTokens(refreshToken!)
      accessToken = tokens.access_token
      refreshToken = tokens.refresh_token || refreshToken
      expiresAt = Date.now() + tokens.expires_in * 1000
    } catch (cause) {
      const error = antigravityReconnectError()
      ;(error as any).cause = cause
      throw error
    }
  }

  let account: Awaited<ReturnType<typeof discoverAntigravityAccount>> | undefined
  if (!config.connection.project_id) {
    account = await discoverAntigravityAccount(accessToken)
  }

  const updated = await getProviderStore().update(config.name, {
    connection: {
      ...config.connection,
      api_key: accessToken,
      refresh_token: refreshToken,
      token_expires_at: expiresAt,
      ...(account?.projectId ? { project_id: account.projectId } : {}),
      ...(account?.email ? { account_email: account.email } : {}),
      ...(account?.tier ? { subscription_type: account.tier } : {})
    }
  })
  if (!updated) throw new Error(`Provider not found: ${config.name}`)
  Object.assign(config.connection, updated.connection)
  return updated
}

function antigravityReconnectError(): Error {
  const error: any = new Error('Google Antigravity session expired. Reconnect this provider from Provider Configuration.')
  error._providerError = true
  error._statusCode = 401
  error._errorBody = {
    message: error.message,
    type: 'authentication_error',
    code: 'antigravity_reconnect_required'
  }
  return error
}
