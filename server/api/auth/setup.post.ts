import { getAuthStore } from '../../stores/auth.store'

export default defineEventHandler(async (event) => {
  const store = getAuthStore()

  if (await store.isSetup()) {
    throw createError({ statusCode: 400, message: 'Password already set. Use /api/auth/login instead.' })
  }

  const { password } = await readBody(event)
  if (!password || password.length < 4) {
    throw createError({ statusCode: 400, message: 'Password must be at least 4 characters.' })
  }

  await store.setPassword(password)
  return { success: true, message: 'Admin password set. You can now log in.' }
})
