import type { ProviderConfig, ModelInfo } from '../core/types'
import { getProviderStore } from '../stores/provider.store'

export class ProviderLoader {
  private providers: Map<string, ProviderConfig> = new Map()
  private models: Map<string, ModelInfo> = new Map()

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

  async fetchAllModels(): Promise<ModelInfo[]> {
    const allModels: ModelInfo[] = []

    for (const providerName of this.providers.keys()) {
      try {
        const models = await this.fetchModels(providerName)
        allModels.push(...models)
      } catch (error) {
        console.error(`Failed to fetch models from ${providerName}:`, error)
      }
    }

    return allModels
  }

  parseModelId(modelId: string): { provider: string; model: string } {
    const index = modelId.indexOf('/')
    if (index === -1) {
      throw new Error(`Invalid model ID format: ${modelId}. Expected: provider/model`)
    }
    return { provider: modelId.slice(0, index), model: modelId.slice(index + 1) }
  }
}
