import { getCookie, setCookie } from 'h3'
import { getAuthStore } from '../../stores/auth.store'

export default defineEventHandler(async (event) => {
  const store = getAuthStore()
  const token = getCookie(event, 'llmhub_session') || ''
  if (token) {
    await store.deleteSession(token)
  }
  setCookie(event, 'llmhub_session', '', { httpOnly: true, path: '/', maxAge: 0 })
  return { success: true }
})
