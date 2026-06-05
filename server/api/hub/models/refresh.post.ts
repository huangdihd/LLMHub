import { ProviderLoader } from '../../../providers/loader'
import { ProviderManager } from '../../../providers/manager'
import { getAuthStore } from '../../../stores/auth.store'

export default defineEventHandler(async () => {
  ProviderLoader.invalidateCache()

  // Re-fetch models to get the latest list
  const manager = new ProviderManager()
  await manager.loadProviders()
  const models = await manager.getModels()

  // Build set of valid model IDs
  const validModelIds = new Set<string>(models.map(m => m.id))

  // Clean up stale model references from all API keys
  const store = getAuthStore()
  await store.cleanupStaleModels(validModelIds)

  return { success: true, message: 'Model cache cleared and stale references cleaned up.' }
})
