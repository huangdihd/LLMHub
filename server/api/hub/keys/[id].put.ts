import { getAuthStore } from '../../../stores/auth.store'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody(event)

  const patch: any = {}
  if (body.name !== undefined) patch.name = body.name
  if (body.allowed_providers !== undefined) patch.allowed_providers = body.allowed_providers
  if (body.allowed_models !== undefined) patch.allowed_models = body.allowed_models
  if (body.monthly_limit !== undefined) patch.monthly_limit = body.monthly_limit
  if (body.model_quotas !== undefined) patch.model_quotas = body.model_quotas
  if (body.provider_quotas !== undefined) patch.provider_quotas = body.provider_quotas
  if (body.fallback_strategy !== undefined) patch.fallback_strategy = body.fallback_strategy

  const store = getAuthStore()
  const updated = await store.updateKey(id, patch)
  if (!updated) throw createError({ statusCode: 404, message: 'Key not found.' })

  return { success: true, key: updated }
})
