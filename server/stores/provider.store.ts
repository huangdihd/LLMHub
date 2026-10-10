import { removeRecordContributions } from '../plugins-runtime/record-values'
import type { ProviderConfig } from '../core/types'
import type { SafeProviderConnection } from '../core/registry'
import { providerRegistry } from '../core/registry'

const STORAGE_PREFIX = 'providers:'

export function validateProviderApiType(value: unknown): void {
  if (value !== undefined && value !== 'responses' && value !== 'chat_completions') {
    throw createError({ statusCode: 400, message: 'Invalid API protocol: api_type must be responses or chat_completions' })
  }
}

export function acceptsProviderExtra(protocol: string): boolean {
  return providerRegistry.get(protocol)?.management?.acceptsExtra !== false
}

export function validateRegisteredProvider(protocol: unknown): asserts protocol is string {
  if (typeof protocol !== 'string' || !providerRegistry.get(protocol)) {
    throw createError({ statusCode: 400, message: 'Provider type is not registered' })
  }
}

/** Validate plugin-specific input without coercing values or accepting undeclared fields. */
export function validatePluginConnectionExtra(
  protocol: string,
  input: unknown,
  existing: Record<string, unknown> = {}
): Record<string, unknown> {
  validateRegisteredProvider(protocol)
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
    throw createError({ statusCode: 400, message: 'connection.extra must be an object' })
  }
  const definition = providerRegistry.get(protocol)!
  const fields = definition.connectionSchema ?? []
  const supplied = (input ?? {}) as Record<string, unknown>
  for (const key of Object.keys(supplied)) {
    if (!fields.some(field => field.key === key)) {
      throw createError({ statusCode: 400, message: `Unknown connection field: ${key}` })
    }
  }
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    const secret = field.type === 'secret' || definition.secretConnectionFields.includes(`extra.${field.key}`)
    const provided = Object.hasOwn(supplied, field.key) ? supplied[field.key] : undefined
    const previous = Object.hasOwn(existing, field.key) ? existing[field.key] : undefined
    const value = provided === undefined || (secret && provided === '' && previous !== undefined)
      ? previous ?? field.default
      : provided
    if (value === undefined || (value === '' && (field.type === 'text' || field.type === 'secret' || field.type === 'select'))) {
      if (field.required) {
        throw createError({ statusCode: 400, message: `Required connection field: ${field.key}` })
      }
      if (value !== undefined) Object.defineProperty(result, field.key, { value, enumerable: true, writable: true, configurable: true })
      continue
    }
    let valid: boolean
    if (field.type === 'number') {
      valid = typeof value === 'number' && Number.isFinite(value)
    } else if (field.type === 'boolean') {
      valid = typeof value === 'boolean'
    } else if (field.type === 'select') {
      valid = Boolean(field.options?.some(option => option.value === value))
    } else {
      valid = typeof value === 'string'
    }
    if (!valid) {
      throw createError({ statusCode: 400, message: `Invalid connection field: ${field.key}` })
    }
    Object.defineProperty(result, field.key, { value, enumerable: true, writable: true, configurable: true })
  }
  return result
}

/**
 * Centralized provider storage using Nitro's built-in storage layer.
 *
 * Each provider is stored under the key `providers:<name>`.
 * This replaces the previous approach of reading/writing JSON files
 * directly from the filesystem in every API handler.
 */
export class ProviderStore {
  /**
   * List all stored provider names (not configs).
   * Use `getAll()` if you need full config objects.
   */
  async list(): Promise<string[]> {
    const storage = useStorage('data')
    const keys = await storage.getKeys(STORAGE_PREFIX)
    return keys.map(k => k.slice(STORAGE_PREFIX.length))
  }

  /** Get all enabled + disabled provider configs. */
  async getAll(): Promise<ProviderConfig[]> {
    const storage = useStorage('data')
    const keys = await storage.getKeys(STORAGE_PREFIX)
    const providers: ProviderConfig[] = []

    for (const key of keys) {
      const config = await storage.getItem<ProviderConfig>(key)
      if (config) {
        providers.push(config)
      }
    }

    return providers
  }

  /** Get a single provider by name (or null). */
  async get(name: string): Promise<ProviderConfig | null> {
    const storage = useStorage('data')
    return storage.getItem<ProviderConfig>(this.resolveKey(name))
  }

  /** Create a new provider. Throws if it already exists. */
  async create(config: ProviderConfig): Promise<ProviderConfig> {
    const storage = useStorage('data')
    const key = this.resolveKey(config.name)

    const existing = await storage.getItem(key)
    if (existing) {
      throw createError({
        statusCode: 409,
        message: `Provider '${config.name}' already exists`
      })
    }

    // Normalise: ensure no duplicate root-level legacy fields leak through
    const clean = this.normalise(config)
    const defaults = providerRegistry.get(clean.protocol)?.management?.createConnectionDefaults
    for (const [field, value] of Object.entries(defaults ?? {})) {
      if ((clean.connection as Record<string, unknown>)[field] === undefined) {
        (clean.connection as Record<string, unknown>)[field] = value
      }
    }
    await storage.setItem(key, clean)
    return clean
  }

  /** Create or overwrite a provider (upsert). */
  async save(config: ProviderConfig): Promise<ProviderConfig> {
    const storage = useStorage('data')
    const clean = this.normalise(config)
    await storage.setItem(this.resolveKey(config.name), clean)
    return clean
  }

  /** Update an existing provider. Returns null when not found. */
  async update(
    name: string,
    patch: Partial<ProviderConfig>
  ): Promise<ProviderConfig | null> {
    const existing = await this.get(name)
    if (!existing) return null

    const nextProtocol = patch.protocol ?? existing.protocol
    const previousExtra = nextProtocol === existing.protocol ? existing.connection.extra : undefined
    const merged: ProviderConfig = {
      ...existing,
      ...patch,
      connection: {
        ...existing.connection,
        ...(patch.connection || {}),
        ...(acceptsProviderExtra(nextProtocol) && patch.connection?.extra !== undefined
          ? { extra: { ...previousExtra, ...patch.connection.extra } }
          : {})
      }
    }

    const clean = this.normalise(merged)
    clean.name = name // name is immutable
    await useStorage('data').setItem(this.resolveKey(name), clean)
    return clean
  }

  /** Delete a provider by name. Returns true when something was deleted. */
  async delete(name: string): Promise<boolean> {
    const storage = useStorage('data')
    const key = this.resolveKey(name)

    const existing = await storage.getItem(key)
    if (!existing) return false

    await storage.removeItem(key)
    await removeRecordContributions(storage, 'providers', name)
    return true
  }

  /** Strip credentials from provider API responses. */
  sanitize(config: ProviderConfig): Omit<ProviderConfig, 'connection'> & { connection: SafeProviderConnection } {
    const { connection, ...rest } = config
    const definition = providerRegistry.get(config.protocol)
    const {
      api_key, refresh_token, id_token: _idToken, device_id: _deviceId,
      account_id: _accountId, project_id: _projectId, account_email: _accountEmail,
      ...safeConnection
    } = connection
    if (acceptsProviderExtra(config.protocol) && safeConnection.extra) {
      // When a plugin is unavailable its schema cannot identify secrets: fail closed.
      safeConnection.extra = definition ? { ...safeConnection.extra } : {}
      for (const field of definition?.connectionSchema ?? []) {
        if (field.type === 'secret') delete safeConnection.extra[field.key]
      }
    }
    for (const field of definition?.secretConnectionFields ?? []) {
      if (field.startsWith('extra.') && safeConnection.extra) {
        delete safeConnection.extra[field.slice('extra.'.length)]
      } else {
        delete (safeConnection as Record<string, unknown>)[field]
      }
    }
    return {
      ...rest,
      connection: {
        ...safeConnection,
        authenticated: Boolean(api_key && (!definition?.requiresRefreshToken || refresh_token))
      }
    }
  }

  /** Check whether a provider exists. */
  async exists(name: string): Promise<boolean> {
    const storage = useStorage('data')
    return storage.hasItem(this.resolveKey(name))
  }

  // ---- helpers -----------------------------------------------------------

  private resolveKey(name: string): string {
    return `${STORAGE_PREFIX}${name}`
  }

  /**
   * Strip legacy root-level fields that belong inside `connection`
   * so every stored document follows the canonical shape.
   */
  private normalise(config: ProviderConfig): ProviderConfig {
    const { name, display_name, protocol, enabled, use_custom_models, normalize_cch, connection, models, defaults } = config
    validateProviderApiType(connection?.api_type)

    const clean: ProviderConfig = {
      name,
      display_name: display_name || name,
      protocol: protocol || providerRegistry.defaultProviderId,
      enabled: enabled !== false,
      use_custom_models: use_custom_models ?? false,
      connection: {
        api_key: connection?.api_key ?? '',
        base_url: connection?.base_url ?? '',
        timeout: connection?.timeout ?? 30000,
        enable_timeout: connection?.enable_timeout ?? true,
        max_retries: connection?.max_retries ?? 3,
        ...(connection?.api_type !== undefined ? { api_type: connection.api_type } : {}),
        ...(connection?.version ? { version: connection.version } : {}),
        ...(connection?.device_id ? { device_id: connection.device_id } : {}),
        ...(connection?.account_id ? { account_id: connection.account_id } : {}),
        ...(connection?.refresh_token ? { refresh_token: connection.refresh_token } : {}),
        ...(connection?.id_token ? { id_token: connection.id_token } : {}),
        ...(connection?.token_expires_at ? { token_expires_at: connection.token_expires_at } : {}),
        ...(connection?.client_version ? { client_version: connection.client_version } : {}),
        ...(connection?.auto_reset_on_quota_exhausted !== undefined
          ? { auto_reset_on_quota_exhausted: connection.auto_reset_on_quota_exhausted }
          : {}),
        ...(connection?.use_ai_credits_on_quota_exhausted !== undefined
          ? { use_ai_credits_on_quota_exhausted: connection.use_ai_credits_on_quota_exhausted }
          : {}),
        ...(connection?.subscription_type ? { subscription_type: connection.subscription_type } : {}),
        ...(connection?.rate_limit_tier ? { rate_limit_tier: connection.rate_limit_tier } : {}),
        ...(connection?.project_id ? { project_id: connection.project_id } : {}),
        ...(connection?.account_email ? { account_email: connection.account_email } : {}),
        ...(acceptsProviderExtra(protocol) && connection?.extra !== undefined
          ? { extra: { ...connection.extra } }
          : {})
      },
      models: models ?? [],
      ...(defaults ? { defaults } : {})
    }

    if (normalize_cch !== undefined) {
      clean.normalize_cch = normalize_cch
    }

    return clean
  }
}

// ---- singleton -----------------------------------------------------------

let _store: ProviderStore | null = null

/** Return the singleton ProviderStore instance. */
export function getProviderStore(): ProviderStore {
  if (!_store) {
    _store = new ProviderStore()
  }
  return _store
}
