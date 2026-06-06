import crypto from 'crypto'

// ============================================================
// Types
// ============================================================

export interface FallbackStrategy {
  enabled: boolean
  name: string
  priority: string[]
}

export interface ApiKeyRecord {
  id: string
  name: string
  hash: string
  allowed_providers: string[]
  allowed_models: string[]
  monthly_limit: number        // 0 = unlimited
  tokens_used: number          // this month
  current_month: string        // "2025-06"
  call_count: number           // total
  created_at: string
  model_quotas: Record<string, number>     // model_id -> monthly token limit
  model_usage: Record<string, number>      // model_id -> tokens used this month
  provider_quotas: Record<string, number>  // provider_name -> monthly token limit
  provider_usage: Record<string, number>   // provider_name -> tokens used this month
  fallback_strategy: FallbackStrategy
}

export interface ApiKeyPublic {
  id: string
  name: string
  allowed_providers: string[]
  allowed_models: string[]
  monthly_limit: number
  tokens_used: number
  call_count: number
  created_at: string
  model_quotas: Record<string, number>
  model_usage: Record<string, number>
  provider_quotas: Record<string, number>
  provider_usage: Record<string, number>
  fallback_strategy: FallbackStrategy
}

export interface BruteForceConfig {
  enabled: boolean
  ip_header: string          // '' = use direct remoteAddress
  max_attempts: number
  lockout_minutes: number
  rate_limit_enabled: boolean
  rate_limit_max_rpm: number // 0 = unlimited
}

export interface BruteForceEntry {
  failures: number
  locked_until: number | null
}

export interface SSRFConfig {
  enabled: boolean
  allowed_hosts: string[]
}

// ============================================================
// AuthStore
// ============================================================

const SESSION_TTL = 24 * 60 * 60 * 1000

export class AuthStore {
  // ---- API Keys --------------------------------------------------

  async generateKey(name: string): Promise<{ record: ApiKeyRecord; plainKey: string }> {
    const plain = crypto.randomBytes(32).toString('hex')
    const hash = crypto.createHash('sha256').update(plain).digest('hex')

    const record: ApiKeyRecord = {
      id: crypto.randomUUID(),
      name: name || 'Unnamed',
      hash,
      allowed_providers: [],
      allowed_models: [],
      monthly_limit: 0,
      tokens_used: 0,
      current_month: this.monthKey(),
      call_count: 0,
      created_at: new Date().toISOString(),
      model_quotas: {},
      model_usage: {},
      provider_quotas: {},
      provider_usage: {},
      fallback_strategy: { enabled: false, name: 'auto', priority: [] }
    }

    const keys = await this.readKeys()
    keys.push(record)
    await this.writeKeys(keys)
    return { record, plainKey: plain }
  }

  async listKeys(): Promise<ApiKeyPublic[]> {
    const keys = await this.readKeys()
    // Auto-reset monthly counters if month changed
    const month = this.monthKey()
    let changed = false
    for (const k of keys) {
      if (k.current_month !== month) {
        k.tokens_used = 0
        k.model_usage = k.model_usage ? {} : {}
        k.provider_usage = k.provider_usage ? {} : {}
        k.current_month = month
        changed = true
      }
    }
    if (changed) await this.writeKeys(keys)

    return keys.map(k => ({
      id: k.id,
      name: k.name,
      allowed_providers: k.allowed_providers,
      allowed_models: k.allowed_models,
      monthly_limit: k.monthly_limit,
      tokens_used: k.tokens_used,
      call_count: k.call_count,
      created_at: k.created_at,
      model_quotas: k.model_quotas || {},
      model_usage: k.model_usage || {},
      provider_quotas: k.provider_quotas || {},
      provider_usage: k.provider_usage || {},
      fallback_strategy: k.fallback_strategy || { enabled: false, name: 'auto', priority: [] }
    }))
  }

  async getKeyById(id: string): Promise<ApiKeyRecord | null> {
    const keys = await this.readKeys()
    return keys.find(k => k.id === id) || null
  }

  async getKeyRecord(key: string): Promise<ApiKeyRecord | null> {
    if (!key) return null
    const hash = crypto.createHash('sha256').update(key).digest('hex')
    const keys = await this.readKeys()
    return keys.find(k => k.hash === hash) || null
  }

  async updateKey(id: string, patch: Partial<ApiKeyRecord>): Promise<ApiKeyRecord | null> {
    const keys = await this.readKeys()
    const idx = keys.findIndex(k => k.id === id)
    if (idx === -1) return null

    // Cannot modify hash, id, tokens_used, call_count, model_usage, provider_usage via patch
    const { hash, tokens_used, call_count, current_month, id: _id, model_usage, provider_usage, ...allowed } = patch
    Object.assign(keys[idx], allowed)
    await this.writeKeys(keys)
    return keys[idx]
  }

  async revokeKey(id: string): Promise<boolean> {
    const keys = await this.readKeys()
    const filtered = keys.filter(k => k.id !== id)
    if (filtered.length === keys.length) return false
    await this.writeKeys(filtered)
    return true
  }

  /** Increment usage for a key record. Must pass the record (already looked up). */
  async addUsage(record: ApiKeyRecord, tokens: number, model?: string, provider?: string): Promise<void> {
    const keys = await this.readKeys()
    const target = keys.find(k => k.id === record.id)
    if (!target) return

    const month = this.monthKey()
    if (target.current_month !== month) {
      target.tokens_used = 0
      target.model_usage = target.model_usage ? {} : {}
      target.provider_usage = target.provider_usage ? {} : {}
      target.current_month = month
    }
    target.tokens_used += tokens
    target.call_count += 1

    if (model) {
      if (!target.model_usage) target.model_usage = {}
      target.model_usage[model] = (target.model_usage[model] || 0) + tokens
    }
    if (provider) {
      if (!target.provider_usage) target.provider_usage = {}
      target.provider_usage[provider] = (target.provider_usage[provider] || 0) + tokens
    }

    await this.writeKeys(keys)
  }

  // ---- Admin Password --------------------------------------------

  async isSetup(): Promise<boolean> {
    return useStorage('data').hasItem('auth:password')
  }

  async setPassword(plain: string): Promise<void> {
    const salt = crypto.randomBytes(16).toString('hex')
    const hash = await this.scryptHash(plain, salt)
    await useStorage('data').setItem('auth:password', { hash, salt })
  }

  async verifyPassword(plain: string): Promise<boolean> {
    const record = await useStorage('data').getItem<{ hash: string; salt: string }>('auth:password')
    if (!record) return false
    const hash = await this.scryptHash(plain, record.salt)
    return hash === record.hash
  }

  // ---- Session ---------------------------------------------------

  async createSession(): Promise<string> {
    const token = crypto.randomUUID()
    await useStorage('data').setItem(`auth:sessions:${token}`, {
      created_at: Date.now(),
      expires_at: Date.now() + SESSION_TTL
    })
    return token
  }

  async validateSession(token: string): Promise<boolean> {
    if (!token) return false
    const s = await useStorage('data').getItem<{ expires_at: number }>(`auth:sessions:${token}`)
    if (!s) return false
    if (Date.now() > s.expires_at) {
      await useStorage('data').removeItem(`auth:sessions:${token}`)
      return false
    }
    return true
  }

  async deleteSession(token: string): Promise<void> {
    await useStorage('data').removeItem(`auth:sessions:${token}`)
  }

  // ---- Brute-force Protection ------------------------------------

  async getBruteForceConfig(): Promise<BruteForceConfig> {
    const cfg = await useStorage('data').getItem<BruteForceConfig>('auth:bf-config')
    return cfg || { enabled: false, ip_header: '', max_attempts: 5, lockout_minutes: 15, rate_limit_enabled: false, rate_limit_max_rpm: 0 }
  }

  async setBruteForceConfig(cfg: BruteForceConfig): Promise<void> {
    await useStorage('data').setItem('auth:bf-config', cfg)
  }

  async getBruteForceEntry(ip: string): Promise<BruteForceEntry | null> {
    return useStorage('data').getItem<BruteForceEntry>(`auth:bf:${ip}`)
  }

  async recordFailedAttempt(ip: string, cfg: BruteForceConfig): Promise<void> {
    const entry = (await this.getBruteForceEntry(ip)) || { failures: 0, locked_until: null }
    entry.failures++
    if (entry.failures >= cfg.max_attempts) {
      entry.locked_until = Date.now() + cfg.lockout_minutes * 60 * 1000
    }
    await useStorage('data').setItem(`auth:bf:${ip}`, entry)
  }

  async clearBruteForce(ip: string): Promise<void> {
    await useStorage('data').removeItem(`auth:bf:${ip}`)
  }

  // ---- Rate Limiting (API calls) ----------------------------------

  async checkRateLimit(ip: string, cfg: BruteForceConfig): Promise<{ allowed: boolean; retryAfter?: number }> {
    if (!cfg.rate_limit_enabled || cfg.rate_limit_max_rpm <= 0) {
      return { allowed: true }
    }

    const key = `auth:rl:${ip}`
    const windowStart = Date.now() - 60 * 1000
    const entry = await useStorage('data').getItem<{ count: number; windowStart: number }>(key)

    if (!entry || entry.windowStart < windowStart) {
      await useStorage('data').setItem(key, { count: 1, windowStart: Date.now() })
      return { allowed: true }
    }

    if (entry.count >= cfg.rate_limit_max_rpm) {
      const retryAfter = Math.ceil((entry.windowStart + 60 * 1000 - Date.now()) / 1000)
      return { allowed: false, retryAfter }
    }

    entry.count++
    await useStorage('data').setItem(key, entry)
    return { allowed: true }
  }

  // ---- SSRF Protection --------------------------------------------

  async getSSRFConfig(): Promise<SSRFConfig> {
    const cfg = await useStorage('data').getItem<SSRFConfig>('auth:ssrf-config')
    return cfg || { enabled: false, allowed_hosts: [] }
  }

  async setSSRFConfig(cfg: SSRFConfig): Promise<void> {
    await useStorage('data').setItem('auth:ssrf-config', cfg)
  }

  // ---- Model Cleanup ---------------------------------------------

  /** Remove stale model references from all keys after provider model list changes. */
  async cleanupStaleModels(validModelIds: Set<string>): Promise<void> {
    const keys = await this.readKeys()
    let changed = false
    for (const k of keys) {
      // Clean up allowed_models
      if (k.allowed_models?.length > 0) {
        const before = k.allowed_models.length
        k.allowed_models = k.allowed_models.filter(m => validModelIds.has(m))
        if (k.allowed_models.length !== before) changed = true
      }
      // Clean up model_quotas
      if (k.model_quotas) {
        for (const m of Object.keys(k.model_quotas)) {
          if (!validModelIds.has(m)) {
            delete k.model_quotas[m]
            changed = true
          }
        }
      }
      // Clean up model_usage
      if (k.model_usage) {
        for (const m of Object.keys(k.model_usage)) {
          if (!validModelIds.has(m)) {
            delete k.model_usage[m]
            changed = true
          }
        }
      }
    }
    if (changed) await this.writeKeys(keys)
  }

  // ---- Internal --------------------------------------------------

  private async readKeys(): Promise<ApiKeyRecord[]> {
    return (await useStorage('data').getItem<ApiKeyRecord[]>('auth:api-keys')) || []
  }

  private async writeKeys(keys: ApiKeyRecord[]): Promise<void> {
    await useStorage('data').setItem('auth:api-keys', keys)
  }

  private monthKey(): string {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  }

  private scryptHash(password: string, salt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, 64, (err, derivedKey) => {
        if (err) reject(err)
        else resolve(derivedKey.toString('hex'))
      })
    })
  }
}

// ---- Singleton ---------------------------------------------------

let _store: AuthStore | null = null

export function getAuthStore(): AuthStore {
  if (!_store) _store = new AuthStore()
  return _store
}
