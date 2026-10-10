import type { ProviderConfig, ModelInfo } from '../core/types'
import { getProviderStore } from '../stores/provider.store'
import { providerRegistry } from './builtins'
import { fetchCodexModels } from './model-discovery'
import { fetchWithRetry } from '../utils/fetch'
import type { ModelDiscoveryContext } from '../core/registry'

const MODEL_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export class ProviderLoader {
  private providers: Map<string, ProviderConfig> = new Map()
  /** In-memory model cache shared across all ProviderLoader instances */
  private static modelCache: { timestamp: number; models: ModelInfo[] } | null = null
  private static modelRefreshPromise: Promise<ModelInfo[]> | null = null
  private static cacheGeneration = 0

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

    const definition = providerRegistry.get(config.protocol)
    if (!definition) {
      console.warn(`[LLMHub] Skipping unknown provider protocol: ${config.protocol}`)
      return []
    }

    if (config.use_custom_models) {
      return config.models.map(m => ({
        id: `${providerName}/${m.id}`,
        provider: providerName,
        name: m.id,
        display_name: m.display_name,
        capabilities: m.capabilities
      }))
    }

    const startedAt = Date.now()
    try {
      const context: ModelDiscoveryContext = {
        fetcher: (url, options = {}) => fetchWithRetry(url, {
          ...options,
          timeout: 10_000,
          enable_timeout: true,
          maxRetries: 1
        }, config.connection)
      }
      return await definition.fetchModels(config, context)
    } catch (error) {
      console.error(`Failed to fetch models from ${providerName}:`, error)
    } finally {
      console.info(`[LLMHub] Model discovery for "${providerName}" completed in ${Date.now() - startedAt}ms`)
    }

    return config.models.map(m => ({
      id: `${providerName}/${m.id}`,
      provider: providerName,
      name: m.id,
      display_name: m.display_name,
      capabilities: m.capabilities
    }))
  }

  // Retain the existing discovery entry point used by adapter regression tests.
  private fetchCodexModels(config: ProviderConfig): Promise<ModelInfo[]> {
    return fetchCodexModels(config)
  }

  /** Fetch models from all providers, returning stale cache while it refreshes. */
  async fetchAllModels(): Promise<ModelInfo[]> {
    const cache = ProviderLoader.modelCache
    if (cache && Date.now() - cache.timestamp < MODEL_CACHE_TTL) {
      return cache.models
    }

    if (cache) {
      void this.refreshModelCache().catch(error => {
        console.error('[LLMHub] Failed to refresh model cache:', error)
      })
      return cache.models
    }

    return this.refreshModelCache()
  }

  private refreshModelCache(): Promise<ModelInfo[]> {
    if (ProviderLoader.modelRefreshPromise) {
      return ProviderLoader.modelRefreshPromise
    }

    const generation = ProviderLoader.cacheGeneration
    const providerNames = Array.from(this.providers.keys())
    const refreshPromise: Promise<ModelInfo[]> = Promise.all(
      providerNames.map(name =>
        this.fetchModels(name).catch(error => {
          console.error(`Failed to fetch models from ${name}:`, error)
          return [] as ModelInfo[]
        })
      )
    ).then(results => {
      const models = results.flat()
      if (generation === ProviderLoader.cacheGeneration) {
        ProviderLoader.modelCache = { timestamp: Date.now(), models }
      }
      return models
    }).finally(() => {
      if (ProviderLoader.modelRefreshPromise === refreshPromise) {
        ProviderLoader.modelRefreshPromise = null
      }
    })

    ProviderLoader.modelRefreshPromise = refreshPromise
    return refreshPromise
  }

  /** Invalidate the model cache (called after provider config changes). */
  static invalidateCache(): void {
    ProviderLoader.modelCache = null
    ProviderLoader.modelRefreshPromise = null
    ProviderLoader.cacheGeneration++
  }

  parseModelId(modelId: string): { provider: string; model: string } {
    const index = modelId.indexOf('/')
    if (index === -1) {
      throw new Error(`Invalid model ID format: ${modelId}. Expected: provider/model`)
    }
    return { provider: modelId.slice(0, index), model: modelId.slice(index + 1) }
  }
}
