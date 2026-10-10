import type { ProviderConfig, ModelInfo } from '../../server/core/types'
import { fetchWithRetry } from '../../server/utils/fetch'
import { ensureClaudeAccessToken } from './claude-token-manager'
import { CLAUDE_CODE_BETA } from './claude-auth'

const MODEL_DISCOVERY_TIMEOUT = 10_000
const MODEL_DISCOVERY_MAX_RETRIES = 1
const MODEL_DISCOVERY_FETCH_OPTIONS = {
  timeout: MODEL_DISCOVERY_TIMEOUT,
  enable_timeout: true,
  maxRetries: MODEL_DISCOVERY_MAX_RETRIES
} as const

export async function fetchClaudeSubscriptionModels(config: ProviderConfig): Promise<ModelInfo[]> {
  config = await ensureClaudeAccessToken(config)
  const response = await fetchWithRetry(`${config.connection.base_url.replace(/\/$/, '')}/v1/models`, {
    ...MODEL_DISCOVERY_FETCH_OPTIONS,
    headers: {
      'Authorization': `Bearer ${config.connection.api_key}`,
      'Accept': 'application/json',
      'anthropic-version': config.connection.version || '2023-06-01',
      'anthropic-beta': CLAUDE_CODE_BETA,
      'User-Agent': 'claude-cli/1.0.0',
      'x-app': 'cli'
    }
  }, config.connection)

  if (!response.ok) throw new Error(`Failed to fetch Claude subscription models: ${response.status}`)
  const data = await response.json() as any
  return (data.data || []).map((model: any) => {
    const id = model.id
    const configured = config.models.find(item => item.id === id)
    return {
      id: `${config.name}/${id}`,
      provider: config.name,
      name: id,
      display_name: configured?.display_name || model.display_name || id,
      capabilities: configured?.capabilities || { vision: true, tools: true, streaming: true }
    }
  }).filter((model: ModelInfo) => !!model.name)
}
