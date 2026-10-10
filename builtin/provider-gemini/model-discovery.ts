import type { ProviderConfig, ModelInfo } from '../../server/core/types'
import { fetchWithRetry } from '../../server/utils/fetch'

const MODEL_DISCOVERY_TIMEOUT = 10_000
const MODEL_DISCOVERY_MAX_RETRIES = 1
const MODEL_DISCOVERY_FETCH_OPTIONS = {
  timeout: MODEL_DISCOVERY_TIMEOUT,
  enable_timeout: true,
  maxRetries: MODEL_DISCOVERY_MAX_RETRIES
} as const

export async function fetchGeminiModels(config: ProviderConfig): Promise<ModelInfo[]> {
  try {
    const response = await fetchWithRetry(`${config.connection.base_url}/v1beta/models`, {
      ...MODEL_DISCOVERY_FETCH_OPTIONS,
      headers: {
        'x-goog-api-key': config.connection.api_key
      }
    }, config.connection)

    if (response.ok) {
      const data = await response.json() as any
      const models: ModelInfo[] = []

      for (const model of data.models || []) {
        const modelId = model.name?.replace('models/', '') || model.id
        const modelConfig = config.models.find(m => m.id === modelId)
        if (model.supportedGenerationMethods?.includes('generateContent')) {
          models.push({
            id: `${config.name}/${modelId}`,
            provider: config.name,
            name: modelId,
            display_name: modelConfig?.display_name || model.displayName || modelId,
            capabilities: modelConfig?.capabilities
          })
        }
      }

      return models
    }
  } catch (error) {
    console.error('Failed to fetch Gemini models from API:', error)
  }

  return config.models.map(m => ({
    id: `${config.name}/${m.id}`,
    provider: config.name,
    name: m.id,
    display_name: m.display_name,
    capabilities: m.capabilities
  }))
}
