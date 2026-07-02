import { getAuthStore } from '../../../stores/auth.store'
import { totpURI } from '../../../utils/totp'

export default defineEventHandler(async () => {
  const store = getAuthStore()
  const current = await store.getTOTPConfig()
  if (current.enabled) {
    throw createError({ statusCode: 400, message: 'TOTP is already enabled. Disable it first.' })
  }
  const secret = await store.beginTOTPSetup()
  return { secret, uri: totpURI(secret) }
})
