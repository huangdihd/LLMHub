import crypto from 'crypto'

// ============================================================
// Types
// ============================================================

export interface ApiKeyEntry {
  id: string
  name: string
  hash: string
  created_at: string
}

export interface ApiKeyPublic {
  id: string
  name: string
  created_at: string
}

// ============================================================
// AuthStore — API keys + admin password + sessions
// ============================================================

const SESSION_TTL = 24 * 60 * 60 * 1000 // 24h

export class AuthStore {
  // ---- API Keys --------------------------------------------------

  /** Generate a new API key and store its hash. Returns plaintext ONLY once. */
  async generateKey(name: string): Promise<{ entry: ApiKeyEntry; plainKey: string }> {
    const plain = crypto.randomBytes(32).toString('hex')
    const hash = crypto.createHash('sha256').update(plain).digest('hex')
    const id = crypto.randomUUID()

    const entry: ApiKeyEntry = {
      id,
      name: name || 'Unnamed',
      hash,
      created_at: new Date().toISOString()
    }

    const storage = useStorage('data')
    const keys = (await storage.getItem<ApiKeyEntry[]>('auth:api-keys')) || []
    keys.push(entry)
    await storage.setItem('auth:api-keys', keys)

    return { entry, plainKey: plain }
  }

  /** List all keys (public info only — no hashes). */
  async listKeys(): Promise<ApiKeyPublic[]> {
    const storage = useStorage('data')
    const keys = (await storage.getItem<ApiKeyEntry[]>('auth:api-keys')) || []
    return keys.map(({ id, name, created_at }) => ({ id, name, created_at }))
  }

  /** Validate a plaintext key against all stored hashes. */
  async validateKey(plain: string): Promise<boolean> {
    if (!plain) return false
    const hash = crypto.createHash('sha256').update(plain).digest('hex')
    const storage = useStorage('data')
    const keys = (await storage.getItem<ApiKeyEntry[]>('auth:api-keys')) || []
    return keys.some(k => k.hash === hash)
  }

  /** Revoke (delete) an API key by id. */
  async revokeKey(id: string): Promise<boolean> {
    const storage = useStorage('data')
    const keys = (await storage.getItem<ApiKeyEntry[]>('auth:api-keys')) || []
    const filtered = keys.filter(k => k.id !== id)
    if (filtered.length === keys.length) return false
    await storage.setItem('auth:api-keys', filtered)
    return true
  }

  // ---- Admin Password --------------------------------------------

  /** Whether any admin password has been set. */
  async isSetup(): Promise<boolean> {
    const storage = useStorage('data')
    return storage.hasItem('auth:password')
  }

  /** Set admin password (first time or reset). Stores scrypt hash. */
  async setPassword(plain: string): Promise<void> {
    const salt = crypto.randomBytes(16).toString('hex')
    const hash = await this.scryptHash(plain, salt)
    await useStorage('data').setItem('auth:password', { hash, salt })
  }

  /** Verify admin password. */
  async verifyPassword(plain: string): Promise<boolean> {
    const storage = useStorage('data')
    const record = await storage.getItem<{ hash: string; salt: string }>('auth:password')
    if (!record) return false
    const hash = await this.scryptHash(plain, record.salt)
    return hash === record.hash
  }

  // ---- Web Session -----------------------------------------------

  async createSession(): Promise<string> {
    const token = crypto.randomUUID()
    const session = {
      token,
      created_at: Date.now(),
      expires_at: Date.now() + SESSION_TTL
    }
    await useStorage('data').setItem(`auth:sessions:${token}`, session)
    return token
  }

  async validateSession(token: string): Promise<boolean> {
    if (!token) return false
    const storage = useStorage('data')
    const session = await storage.getItem<{ expires_at: number }>(`auth:sessions:${token}`)
    if (!session) return false
    if (Date.now() > session.expires_at) {
      await storage.removeItem(`auth:sessions:${token}`)
      return false
    }
    return true
  }

  async deleteSession(token: string): Promise<void> {
    await useStorage('data').removeItem(`auth:sessions:${token}`)
  }

  // ---- Internal --------------------------------------------------

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
