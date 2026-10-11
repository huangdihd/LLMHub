import { getCookie, createError } from 'h3'
import type { H3Event } from 'h3'
import { getAuthStore } from '../stores/auth.store'

export default defineEventHandler(async (event: H3Event) => {
  if (!event.path.startsWith('/api/hub')) return
  if (event.path.startsWith('/api/auth')) return

  const store = getAuthStore()
  // Before a password exists nobody is the administrator yet, so nobody may manage the gateway.
  if (!(await store.isSetup())) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthorized',
      data: { error: { message: 'Set an administrator password first.' } }
    })
  }

  const token = getCookie(event, 'llmhub_session') || ''
  if (!token || !(await store.validateSession(token))) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthorized',
      data: { error: { message: 'Authentication required.' } }
    })
  }
})
