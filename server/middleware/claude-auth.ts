import { getHeader, createError } from 'h3'
import type { H3Event } from 'h3'
import { getAuthStore } from '../stores/auth.store'

export default defineEventHandler(async (event: H3Event) => {
  // Only protect /api/claude routes
  if (!event.path.startsWith('/api/claude')) return

  const store = getAuthStore()

  // If no API keys are configured, skip auth (bootstrap mode)
  const keys = await store.listKeys()
  if (keys.length === 0) return

  const providedKey = extractApiKey(event)
  if (!providedKey || !(await store.validateKey(providedKey))) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthorized',
      data: {
        error: {
          message: 'Invalid API Key. Provide via Authorization: Bearer <key> or X-API-Key header.',
          type: 'authentication_error',
          code: 'invalid_api_key'
        }
      }
    })
  }
})

function extractApiKey(event: H3Event): string {
  const authHeader = getHeader(event, 'Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim()
  }
  const apiKeyHeader = getHeader(event, 'X-API-Key')
  return apiKeyHeader?.trim() || ''
}
