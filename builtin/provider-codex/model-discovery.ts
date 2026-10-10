import type { ProviderConfig, ModelInfo } from '../../server/core/types'
import { fetchWithRetry } from '../../server/utils/fetch'
import { CODEX_DEFAULT_CLIENT_VERSION, extractChatGptAccountId } from './codex-auth'
import { ensureCodexAccessToken } from './codex-token-manager'

const MODEL_DISCOVERY_TIMEOUT = 10_000
const MODEL_DISCOVERY_MAX_RETRIES = 1
const MODEL_DISCOVERY_FETCH_OPTIONS = {
  timeout: MODEL_DISCOVERY_TIMEOUT,
  enable_timeout: true,
  maxRetries: MODEL_DISCOVERY_MAX_RETRIES
} as const

export async function fetchCodexModels(config: ProviderConfig): Promise<ModelInfo[]> {
  config = await ensureCodexAccessToken(config)
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${config.connection.api_key}`,
    'Accept': 'application/json',
    'x-codex-installation-id': config.connection.device_id || '',
    'originator': 'llmhub'
  }
  const accountId = config.connection.account_id
    || extractChatGptAccountId(config.connection.id_token)
    || extractChatGptAccountId(config.connection.api_key)
  if (accountId) {
    headers['ChatGPT-Account-Id'] = accountId
  }

  const modelsUrl = new URL(`${config.connection.base_url.replace(/\/$/, '')}/models`)
  modelsUrl.searchParams.set(
    'client_version',
    config.connection.client_version || CODEX_DEFAULT_CLIENT_VERSION
  )
  const response = await fetchWithRetry(modelsUrl.toString(), {
    ...MODEL_DISCOVERY_FETCH_OPTIONS,
    headers
  }, config.connection)

  if (!response.ok) throw new Error(`Failed to fetch Codex models: ${response.status}`)
  const data = await response.json() as any
  const upstream = data.models || data.data || []
  return upstream.map((model: any) => {
    const id = model.slug || model.id || model.model
    const configured = config.models.find(m => m.id === id)
    return {
      id: `${config.name}/${id}`,
      provider: config.name,
      name: id,
      display_name: configured?.display_name || model.display_name || model.displayName || id,
      capabilities: configured?.capabilities || { tools: true, streaming: true }
    }
  }).filter((model: ModelInfo) => !!model.name)
}
