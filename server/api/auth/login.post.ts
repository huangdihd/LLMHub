import { setCookie } from 'h3'
import { getAuthStore } from '../../stores/auth.store'

export default defineEventHandler(async (event) => {
  const store = getAuthStore()

  if (!(await store.isSetup())) {
    throw createError({ statusCode: 400, message: 'No password set. Please set up first via /api/auth/setup.' })
  }

  const { password } = await readBody(event)
  if (!password) {
    throw createError({ statusCode: 400, message: 'Password is required.' })
  }

  const valid = await store.verifyPassword(password)
  if (!valid) {
    throw createError({ statusCode: 401, message: 'Invalid password.' })
  }

  const token = await store.createSession()
  setCookie(event, 'llmhub_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 24 * 60 * 60 // 24h
  })

  return { success: true }
})
