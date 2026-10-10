import type { ApiKeyRecord } from './auth.store'

// The api-keys record is one JSON file rewritten in full on every usage
// update (fire-and-forget from the routes). The fs write is not atomic, so
// an unserialized read can see a half-written file and reject a valid key.
let keysLock: Promise<unknown> = Promise.resolve()
function withKeysLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = keysLock.then(fn, fn)
  keysLock = run.catch(() => {})
  return run
}

export async function readApiKeys(): Promise<ApiKeyRecord[]> {
  return withKeysLock(async () =>
    (await useStorage('data').getItem<ApiKeyRecord[]>('auth:api-keys')) || []
  )
}

export async function writeApiKeys(keys: ApiKeyRecord[]): Promise<void> {
  await withKeysLock(() => useStorage('data').setItem('auth:api-keys', keys))
}

export function monthKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

