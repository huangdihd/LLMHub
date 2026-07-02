import { getCookie } from 'h3'
import { getAuthStore } from '../../stores/auth.store'

export default defineEventHandler(async (event) => {
  const store = getAuthStore()
  const initialized = await store.isSetup()
  const token = getCookie(event, 'llmhub_session') || ''
  const authenticated = token ? await store.validateSession(token) : false
  const totp = await store.getTOTPConfig()
  return { initialized, authenticated, totp_enabled: totp.enabled }
})
