import { getAuthStore } from '../../stores/auth.store'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const store = getAuthStore()
  const current = await store.getBruteForceConfig()

  const updated = {
    enabled: body.enabled ?? current.enabled,
    ip_header: body.ip_header ?? current.ip_header,
    max_attempts: body.max_attempts ?? current.max_attempts,
    lockout_minutes: body.lockout_minutes ?? current.lockout_minutes
  }

  await store.setBruteForceConfig(updated)
  return { success: true, config: updated }
})
