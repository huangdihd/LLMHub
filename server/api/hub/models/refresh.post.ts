import { ProviderLoader } from '../../../providers/loader'

export default defineEventHandler(async () => {
  ProviderLoader.invalidateCache()
  return { success: true, message: 'Model cache cleared. Next request will re-fetch.' }
})
