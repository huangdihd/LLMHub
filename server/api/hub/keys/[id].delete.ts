import { getAuthStore } from '../../../stores/auth.store'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const store = getAuthStore()
  const deleted = await store.revokeKey(id)
  if (!deleted) throw createError({ statusCode: 404, message: 'Key not found.' })
  return { success: true }
})
