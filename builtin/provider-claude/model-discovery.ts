import type { ProviderConfig, ModelInfo } from '../../server/core/types'
import { fetchWithRetry } from '../../server/utils/fetch'

const MODEL_DISCOVERY_TIMEOUT = 10_000
const MODEL_DISCOVERY_MAX_RETRIES = 1
const MODEL_DISCOVERY_FETCH_OPTIONS = {
  timeout: MODEL_DISCOVERY_TIMEOUT,
  enable_timeout: true,
  maxRetries: MODEL_DISCOVERY_MAX_RETRIES
} as const

export async function fetchClaudeModels(config: ProviderConfig): Promise<ModelInfo[]> {
  try {
    const headers: any = {
      'x-api-key': config.connection.api_key
    }
    if (config.connection.version) {
      headers['anthropic-version'] = config.connection.version
    }

    const response = await fetchWithRetry(`${config.connection.base_url}/v1/models`, {
      ...MODEL_DISCOVERY_FETCH_OPTIONS,
      headers
    }, config.connection)

    if (response.ok) {
      const data = await response.json() as any
      const models: ModelInfo[] = []

      for (const model of data.data || []) {
        const modelConfig = config.models.find(m => m.id === model.id)
        models.push({
          id: `${config.name}/${model.id}`,
          provider: config.name,
          name: model.id,
          display_name: modelConfig?.display_name || model.display_name || model.id,
          capabilities: modelConfig?.capabilities
        })
      }

      return models
    }
  } catch (error) {
    console.error('Failed to fetch Claude models from API:', error)
  }

  return config.models.map(m => ({
    id: `${config.name}/${m.id}`,
    provider: config.name,
    name: m.id,
    display_name: m.display_name,
    capabilities: m.capabilities
  }))
}
