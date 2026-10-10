import type { ProviderConfig, ModelInfo } from '../../server/core/types'
import { fetchWithRetry } from '../../server/utils/fetch'

const MODEL_DISCOVERY_TIMEOUT = 10_000
const MODEL_DISCOVERY_MAX_RETRIES = 1
const MODEL_DISCOVERY_FETCH_OPTIONS = {
  timeout: MODEL_DISCOVERY_TIMEOUT,
  enable_timeout: true,
  maxRetries: MODEL_DISCOVERY_MAX_RETRIES
} as const

export async function fetchOpenAIModels(config: ProviderConfig): Promise<ModelInfo[]> {
  const response = await fetchWithRetry(`${config.connection.base_url}/models`, {
    ...MODEL_DISCOVERY_FETCH_OPTIONS,
    headers: {
      'Authorization': `Bearer ${config.connection.api_key}`
    }
  }, config.connection)

  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status}`)
  }

  const data = await response.json() as any
  const models: ModelInfo[] = []

  for (const model of data.data || []) {
    const modelConfig = config.models.find(m => m.id === model.id)
    
    // 从上游 API 获取 capabilities，尝试多种字段名
    // 获取不到就返回空对象，让客户端认为不支持
    const upstreamCapabilities = model.capabilities || model.supported_capabilities || model.abilities
    const capabilities = modelConfig?.capabilities || upstreamCapabilities || {}
    
    models.push({
      id: `${config.name}/${model.id}`,
      provider: config.name,
      name: model.id,
      display_name: modelConfig?.display_name || model.display_name || model.id,
      capabilities
    })
  }

  return models
}
