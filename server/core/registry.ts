import type { PluginField } from '../../shared/types/plugin'
import type { ModelInfo, ProviderAdapter, ProviderConfig } from './types'

export type SafeProviderConnection = Omit<ProviderConfig['connection'],
  'api_key' | 'refresh_token' | 'id_token' | 'device_id' | 'account_id' | 'project_id' | 'account_email'>
  & { authenticated: boolean }

export interface ModelDiscoveryContext {
  /** Fetch with the loader's fixed ten-second timeout and one retry. */
  fetcher(url: string, options?: RequestInit): Promise<Response>
}

export interface ProviderDefinition {
  id: string
  displayName?: string
  connectionSchema?: PluginField[]
  createAdapter(config: ProviderConfig): ProviderAdapter
  fetchModels(config: ProviderConfig, context: ModelDiscoveryContext): Promise<ModelInfo[]>
  secretConnectionFields: readonly string[]
  requiresRefreshToken?: boolean
}

/** Explicit registration rejects accidental replacement of an existing provider. */
export class ProviderRegistry {
  private definitions = new Map<string, ProviderDefinition>()

  register(definition: ProviderDefinition): () => void {
    if (!definition.id.trim()) throw new Error('Provider ID must not be empty')
    if (this.definitions.has(definition.id)) throw new Error(`Provider already registered: ${definition.id}`)
    this.definitions.set(definition.id, definition)
    return () => { if (this.definitions.get(definition.id) === definition) this.definitions.delete(definition.id) }
  }

  get(id: string): ProviderDefinition | undefined {
    return this.definitions.get(id)
  }

  list(): ProviderDefinition[] {
    return Array.from(this.definitions.values())
  }
}

