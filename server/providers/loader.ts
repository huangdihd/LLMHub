import type { ProviderConfig, ModelInfo } from '../core/types'
import { getProviderStore } from '../stores/provider.store'
import { fetchWithRetry } from '../utils/fetch'
import { CODEX_DEFAULT_CLIENT_VERSION, extractChatGptAccountId } from '../utils/codex-auth'
import { ensureCodexAccessToken } from '../services/codex-token-manager'
import { ensureClaudeAccessToken } from '../services/claude-token-manager'
import { CLAUDE_CODE_BETA } from '../utils/claude-auth'

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
      } else if (config.protocol === 'gemini') {
        return await this.fetchGeminiModels(config)
      } else if (config.protocol === 'codex-subscription') {
        return await this.fetchCodexModels(config)
      } else if (config.protocol === 'claude-subscription') {
        return await this.fetchClaudeSubscriptionModels(config)
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
    const response = await fetchWithRetry(`${config.connection.base_url}/models`, {
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

  private async fetchClaudeModels(config: ProviderConfig): Promise<ModelInfo[]> {
    try {
      const headers: any = {
        'x-api-key': config.connection.api_key
      }
      if (config.connection.version) {
        headers['anthropic-version'] = config.connection.version
      }

      const response = await fetchWithRetry(`${config.connection.base_url}/v1/models`, {
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

  private async fetchClaudeSubscriptionModels(config: ProviderConfig): Promise<ModelInfo[]> {
    config = await ensureClaudeAccessToken(config)
    const response = await fetchWithRetry(`${config.connection.base_url.replace(/\/$/, '')}/v1/models`, {
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

  private async fetchGeminiModels(config: ProviderConfig): Promise<ModelInfo[]> {
    try {
      const response = await fetchWithRetry(`${config.connection.base_url}/v1beta/models`, {
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

  private async fetchCodexModels(config: ProviderConfig): Promise<ModelInfo[]> {
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
