import { getAuthStore } from '../../../stores/auth.store'

export default defineEventHandler(async (event) => {
  const { code } = await readBody(event)
  if (!code) {
    throw createError({ statusCode: 400, message: 'Verification code required.' })
  }
  const ok = await getAuthStore().confirmTOTPSetup(String(code))
  if (!ok) {
    throw createError({ statusCode: 400, message: 'Invalid verification code.' })
  }
  return { success: true }
})
