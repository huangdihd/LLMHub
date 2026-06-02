import crypto from 'crypto'

// ============================================================
// Types
// ============================================================

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
}

export interface BruteForceConfig {
  enabled: boolean
  ip_header: string          // '' = use direct remoteAddress
  max_attempts: number
  lockout_minutes: number
}

export interface BruteForceEntry {
  failures: number
  locked_until: number | null
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
      created_at: new Date().toISOString()
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
      created_at: k.created_at
    }))
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

    // Cannot modify hash, id, tokens_used, call_count via patch
    const { hash, tokens_used, call_count, current_month, id: _id, ...allowed } = patch
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
  async addUsage(record: ApiKeyRecord, tokens: number): Promise<void> {
    const keys = await this.readKeys()
    const target = keys.find(k => k.id === record.id)
    if (!target) return

    const month = this.monthKey()
    if (target.current_month !== month) {
      target.tokens_used = 0
      target.current_month = month
    }
    target.tokens_used += tokens
    target.call_count += 1
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
    return cfg || { enabled: false, ip_header: '', max_attempts: 5, lockout_minutes: 15 }
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
