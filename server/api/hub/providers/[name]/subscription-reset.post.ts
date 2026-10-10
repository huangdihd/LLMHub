import { providerRegistry } from '../../../../core/registry'
import { consumeSubscriptionResetCredit, supportsSubscriptionReset } from '../../../../services/subscription-usage'
import { getProviderStore } from '../../../../stores/provider.store'

export default defineEventHandler(async (event) => {
  try {
    const name = getRouterParam(event, 'name')
    if (!name) throw createError({ statusCode: 400, message: 'Provider name is required' })

    const provider = await getProviderStore().get(name)
    if (!provider) throw createError({ statusCode: 404, message: 'Provider not found' })
    if (!supportsSubscriptionReset(provider.protocol)) {
      throw createError({ statusCode: 400, message: providerRegistry.subscriptionResetErrors.unsupportedProvider })
    }

    const body = await readBody(event)
    const creditId = typeof body?.credit_id === 'string' && body.credit_id.trim()
      ? body.credit_id.trim()
      : undefined
    return await consumeSubscriptionResetCredit(provider, creditId)
  } catch (error: any) {
    if (error.statusCode) throw error
    throwFormattedError(error)
  }
})
