import type { PluginField } from '../../shared/types/plugin'
import type { ModelInfo, ProviderAdapter, ProviderConfig } from './types'

export type SafeProviderConnection = Omit<ProviderConfig['connection'],
  'api_key' | 'refresh_token' | 'id_token' | 'device_id' | 'account_id' | 'project_id' | 'account_email'>
  & { authenticated: boolean }

export interface ModelDiscoveryContext {
  /** Fetch with the loader's fixed ten-second timeout and one retry. */
  fetcher(url: string, options?: RequestInit): Promise<Response>
}

export interface ProviderManagement {
  /** Schema-based plugin fields are accepted unless explicitly disabled. */
  acceptsExtra?: boolean
  /** Legacy creation forms read credentials only from the flat request body. */
  flatCreateCredentials?: boolean
  /** Direct creation and transitions into this type require a separate connection flow. */
  creationError?: string
  protectedConnectionFields?: readonly string[]
  /** Top-level fields with provider-owned normalization rules. */
  flatConnectionFields?: Readonly<Record<string, (value: unknown) => unknown>>
  /** Fill fields still absent after common storage normalization; never override its defaults. */
  createConnectionDefaults?: Partial<ProviderConfig['connection']>
}

export interface ProviderDefinition {
  id: string
  displayName?: string
  connectionSchema?: PluginField[]
  management?: ProviderManagement
  createAdapter(config: ProviderConfig): ProviderAdapter
  fetchModels(config: ProviderConfig, context: ModelDiscoveryContext): Promise<ModelInfo[]>
  secretConnectionFields: readonly string[]
  requiresRefreshToken?: boolean
  refreshAccessToken?(config: ProviderConfig): Promise<ProviderConfig>
  subscriptionUsage?(config: ProviderConfig, fetcher: typeof fetch): Promise<import('../services/subscription-usage').SubscriptionUsage>
  resetSubscriptionUsage?(config: ProviderConfig, creditId: string | undefined, idempotencyKey: string, fetcher: typeof fetch): Promise<import('../services/subscription-usage').SubscriptionResetResult>
  login?: { path: string }
}

/** Explicit registration rejects accidental replacement of an existing provider. */
export class ProviderRegistry {
  /** Set by the composition root, never by protocol-specific core logic. */
  defaultProviderId = ''
  ignoredNestedConnectionUpdates: readonly string[] = []
  subscriptionResetErrors = {
    unsupportedProvider: 'Provider does not support subscription resets',
    unsupportedOperation: 'Usage limit resets are only available for providers supporting subscription resets'
  }
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

export const providerRegistry = new ProviderRegistry()

