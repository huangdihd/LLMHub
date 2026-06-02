import { getAuthStore } from '../../stores/auth.store'

export default defineEventHandler(async (event) => {
  const store = getAuthStore()
  if (await store.isSetup()) {
    throw createError({ statusCode: 400, message: 'Already set up.' })
  }
  const { password } = await readBody(event)
  if (!password || password.length < 4) {
    throw createError({ statusCode: 400, message: 'Password must be at least 4 characters.' })
  }
  await store.setPassword(password)
  return { success: true }
})
