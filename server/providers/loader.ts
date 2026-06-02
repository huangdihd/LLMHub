import type { ProviderConfig, ModelInfo } from '../core/types'
import { getProviderStore } from '../stores/provider.store'

const MODEL_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export class ProviderLoader {
  private providers: Map<string, ProviderConfig> = new Map()
  /** In-memory model cache shared across all ProviderLoader instances */
  private static modelCache: { timestamp: number; models: ModelInfo[] } | null = null

  async loadAll(): Promise<void> {
    const store = getProviderStore()
    const configs = await store.getAll()

    for (const config of configs) {
      if (config.enabled) {
        this.providers.set(config.name, config)
      }
    }
  }

  getProvider(name: string): ProviderConfig | undefined {
    return this.providers.get(name)
  }

  getAllProviders(): ProviderConfig[] {
    return Array.from(this.providers.values())
  }

  async fetchModels(providerName: string): Promise<ModelInfo[]> {
    const config = this.providers.get(providerName)
    if (!config) {
      throw new Error(`Provider not found: ${providerName}`)
    }

    try {
      if (config.use_custom_models) {
        return config.models.map(m => ({
          id: `${providerName}/${m.id}`,
          provider: providerName,
          name: m.id,
          display_name: m.display_name,
          capabilities: m.capabilities
        }))
      }

      if (config.protocol === 'openai') {
        return await this.fetchOpenAIModels(config)
      } else if (config.protocol === 'claude') {
        return await this.fetchClaudeModels(config)
      }
    } catch (error) {
      console.error(`Failed to fetch models from ${providerName}:`, error)
    }

    return config.models.map(m => ({
      id: `${providerName}/${m.id}`,
      provider: providerName,
      name: m.id,
      display_name: m.display_name,
      capabilities: m.capabilities
    }))
  }

  private async fetchOpenAIModels(config: ProviderConfig): Promise<ModelInfo[]> {
    const response = await fetch(`${config.connection.base_url}/models`, {
      headers: {
        'Authorization': `Bearer ${config.connection.api_key}`
      }
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`)
    }

    const data = await response.json() as any
    const models: ModelInfo[] = []

    for (const model of data.data || []) {
      const modelConfig = config.models.find(m => m.id === model.id)
      models.push({
        id: `${config.name}/${model.id}`,
        provider: config.name,
        name: model.id,
        display_name: modelConfig?.display_name || model.id,
        capabilities: modelConfig?.capabilities
      })
    }

    return models
  }

  private async fetchClaudeModels(config: ProviderConfig): Promise<ModelInfo[]> {
    try {
      const headers: any = {
        'x-api-key': config.connection.api_key
      }
      if (config.connection.version) {
        headers['anthropic-version'] = config.connection.version
      }

      const response = await fetch(`${config.connection.base_url}/v1/models`, {
        headers
      })

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

  /** Fetch models from ALL providers in parallel, with 5-min cache. */
  async fetchAllModels(): Promise<ModelInfo[]> {
    // Static cache shared across short-lived instances
    if (ProviderLoader.modelCache && Date.now() - ProviderLoader.modelCache.timestamp < MODEL_CACHE_TTL) {
      return ProviderLoader.modelCache.models
    }

    const providerNames = Array.from(this.providers.keys())
    const results = await Promise.all(
      providerNames.map(name =>
        this.fetchModels(name).catch(err => {
          console.error(`Failed to fetch models from ${name}:`, err)
          return [] as ModelInfo[]
        })
      )
    )

    const allModels = results.flat()
    ProviderLoader.modelCache = { timestamp: Date.now(), models: allModels }
    return allModels
  }

  /** Invalidate the model cache (called after provider config changes). */
  static invalidateCache(): void {
    ProviderLoader.modelCache = null
  }

  parseModelId(modelId: string): { provider: string; model: string } {
    const index = modelId.indexOf('/')
    if (index === -1) {
      throw new Error(`Invalid model ID format: ${modelId}. Expected: provider/model`)
    }
    return { provider: modelId.slice(0, index), model: modelId.slice(index + 1) }
  }
}
