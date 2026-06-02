import { getCookie, createError } from 'h3'
import type { H3Event } from 'h3'
import { getAuthStore } from '../stores/auth.store'

export default defineEventHandler(async (event: H3Event) => {
  if (!event.path.startsWith('/api/hub')) return
  if (event.path.startsWith('/api/auth')) return

  const store = getAuthStore()
  const isSetup = await store.isSetup()
  if (!isSetup) return

  const token = getCookie(event, 'llmhub_session') || ''
  if (!token || !(await store.validateSession(token))) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthorized',
      data: { error: { message: 'Authentication required.' } }
    })
  }
})
