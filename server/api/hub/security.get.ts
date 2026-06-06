import { getAuthStore } from '../../stores/auth.store'

export default defineEventHandler(async () => {
  const store = getAuthStore()
  const bruteForce = await store.getBruteForceConfig()

  const storage = useStorage('data')
  const bfKeys = await storage.getKeys('auth:bf:')
  const locked: { ip: string; failures: number; locked_until: number }[] = []
  for (const key of bfKeys) {
    const entry = await storage.getItem<any>(key)
    if (entry?.locked_until && Date.now() < entry.locked_until) {
      locked.push({ ip: key.replace('auth:bf:', ''), failures: entry.failures, locked_until: entry.locked_until })
    }
  }

  const ssrf = await store.getSSRFConfig()

  return {
    bruteForce,
    locked,
    ssrf
  }
})
