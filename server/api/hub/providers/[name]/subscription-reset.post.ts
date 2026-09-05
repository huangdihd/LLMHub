import { consumeCodexResetCredit } from '../../../../services/subscription-usage'
import { getProviderStore } from '../../../../stores/provider.store'

export default defineEventHandler(async (event) => {
  try {
    const name = getRouterParam(event, 'name')
    if (!name) throw createError({ statusCode: 400, message: 'Provider name is required' })

    const provider = await getProviderStore().get(name)
    if (!provider) throw createError({ statusCode: 404, message: 'Provider not found' })
    if (provider.protocol !== 'codex-subscription') {
      throw createError({ statusCode: 400, message: 'Provider does not use a Codex subscription' })
    }

    const body = await readBody(event)
    const creditId = typeof body?.credit_id === 'string' && body.credit_id.trim()
      ? body.credit_id.trim()
      : undefined
    return await consumeCodexResetCredit(provider, creditId)
  } catch (error: any) {
    if (error.statusCode) throw error
    throwFormattedError(error)
  }
})
