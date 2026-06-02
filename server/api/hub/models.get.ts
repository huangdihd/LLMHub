import { join } from 'path'
import { ProviderManager } from '../../providers/manager'

export default defineEventHandler(async (event) => {
  try {
    const manager = new ProviderManager(join(process.cwd(), 'providers'))
    manager.loadProviders()

    const models = await manager.getModels()

    return { models }
  } catch (error: any) {
    throwFormattedError(error)
  }
})
