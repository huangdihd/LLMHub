import { createError, getCookie, getQuery, readBody, type H3Event } from 'h3'
import { getAuthStore } from '../stores/auth.store'
import { SystemUpdateError } from './manager'

export async function requireSystemSession(event: H3Event): Promise<void> {
  const token = getCookie(event, 'llmhub_session') || ''
  if (!token || !await getAuthStore().validateSession(token)) {
    throw createError({ statusCode: 401, statusMessage: 'Authentication required.' })
  }
}

export async function requireEmptySystemRequest(event: H3Event): Promise<void> {
  if (Object.keys(getQuery(event)).length) throw createError({ statusCode: 400, statusMessage: 'Query parameters are not accepted.' })
  const body = await readBody(event)
  if (body == null || body === '') return
  if (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0) return
  throw createError({ statusCode: 400, statusMessage: 'Only an empty request body is accepted.' })
}

export async function systemOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation() }
  catch (error) {
    if (error instanceof SystemUpdateError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message })
    }
    throw createError({ statusCode: 500, statusMessage: 'System update state is unavailable.' })
  }
}
