import type { ProviderConfig } from '../core/types'

const STORAGE_PREFIX = 'providers:'

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

    const merged: ProviderConfig = {
      ...existing,
      ...patch,
      connection: {
        ...existing.connection,
        ...(patch.connection || {})
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
    return true
  }

  /** Strip sensitive fields (api_key) for public API responses. */
  sanitize(config: ProviderConfig): Omit<ProviderConfig, 'connection'> & { connection: Omit<ProviderConfig['connection'], 'api_key'> } {
    const { connection, ...rest } = config
    const { api_key, ...safeConnection } = connection
    return { ...rest, connection: safeConnection }
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

    const clean: ProviderConfig = {
      name,
      display_name: display_name || name,
      protocol: protocol || 'openai',
      enabled: enabled !== false,
      use_custom_models: use_custom_models ?? false,
      connection: {
        api_key: connection?.api_key ?? '',
        base_url: connection?.base_url ?? '',
        timeout: connection?.timeout ?? 30000,
        enable_timeout: connection?.enable_timeout ?? true,
        max_retries: connection?.max_retries ?? 3,
        ...(connection?.version ? { version: connection.version } : {})
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
