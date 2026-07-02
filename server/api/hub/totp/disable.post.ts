import { getAuthStore } from '../../../stores/auth.store'
import { verifyTOTP } from '../../../utils/totp'

export default defineEventHandler(async (event) => {
  const store = getAuthStore()
  const cfg = await store.getTOTPConfig()
  if (!cfg.enabled) {
    throw createError({ statusCode: 400, message: 'TOTP is not enabled.' })
  }
  // Require a valid current code so a hijacked session alone cannot remove 2FA
  const { code } = await readBody(event)
  if (!code || !verifyTOTP(cfg.secret, String(code))) {
    throw createError({ statusCode: 400, message: 'Invalid verification code.' })
  }
  await store.disableTOTP()
  return { success: true }
})
