import { getAuthStore } from '../../stores/auth.store'

export default defineEventHandler(async (event) => {
  const { name } = await readBody(event)
  const store = getAuthStore()
  const { record, plainKey } = await store.generateKey(name || 'Unnamed')
  return {
    key: {
      id: record.id,
      name: record.name,
      allowed_providers: record.allowed_providers,
      allowed_models: record.allowed_models,
      monthly_limit: record.monthly_limit,
      created_at: record.created_at,
      plain_key: plainKey
    }
  }
})
