import { getSubscriptionUsage } from '../../../../services/subscription-usage'
import { getProviderStore } from '../../../../stores/provider.store'

export default defineEventHandler(async (event) => {
  try {
    const name = getRouterParam(event, 'name')
    if (!name) throw createError({ statusCode: 400, message: 'Provider name is required' })

    const provider = await getProviderStore().get(name)
    if (!provider) throw createError({ statusCode: 404, message: 'Provider not found' })
    if (provider.protocol !== 'codex-subscription' && provider.protocol !== 'claude-subscription') {
      throw createError({ statusCode: 400, message: 'Provider does not use a supported subscription' })
    }

    const query = getQuery(event)
    return await getSubscriptionUsage(provider, query.refresh === '1' || query.refresh === 'true')
  } catch (error: any) {
    if (error.statusCode) throw error
    throwFormattedError(error)
  }
})
