import { getAuthStore } from '../../stores/auth.store'
import type { BruteForceConfig, SSRFConfig } from '../../stores/auth.store'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const store = getAuthStore()

  if (body.bruteForce) {
    const current = await store.getBruteForceConfig()
    const updated: BruteForceConfig = {
      enabled: body.bruteForce.enabled ?? current.enabled,
      ip_header: body.bruteForce.ip_header ?? current.ip_header,
      max_attempts: body.bruteForce.max_attempts ?? current.max_attempts,
      lockout_minutes: body.bruteForce.lockout_minutes ?? current.lockout_minutes,
      rate_limit_enabled: body.bruteForce.rate_limit_enabled ?? current.rate_limit_enabled,
      rate_limit_max_rpm: body.bruteForce.rate_limit_max_rpm ?? current.rate_limit_max_rpm
    }
    await store.setBruteForceConfig(updated)
  }

  if (body.ssrf) {
    const current = await store.getSSRFConfig()
    const updated: SSRFConfig = {
      enabled: body.ssrf.enabled ?? current.enabled,
      allowed_hosts: body.ssrf.allowed_hosts ?? current.allowed_hosts
    }
    await store.setSSRFConfig(updated)
  }

  return { success: true }
})
