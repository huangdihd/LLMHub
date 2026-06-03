import { getAuthStore } from '../../../stores/auth.store'

export default defineEventHandler(async (event) => {
  const ip = getRouterParam(event, 'ip')
  if (!ip) {
    throw createError({ statusCode: 400, message: 'IP address is required' })
  }

  const store = getAuthStore()
  await store.clearBruteForce(ip)
  return { success: true }
})
