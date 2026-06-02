import { getHeader, readBody, setResponseStatus, setResponseHeader, send } from 'h3'
import type { H3Event } from 'h3'
import { getAuthStore } from '../stores/auth.store'

export default defineEventHandler(async (event: H3Event) => {
  if (!event.path.startsWith('/api/claude')) return

  const store = getAuthStore()
  const plainKey = extractApiKey(event)
  if (!plainKey) {
    return sendAuthError(event, 401, 'API Key required. Provide via Authorization: Bearer <key> or X-API-Key header.')
  }

  const record = await store.getKeyRecord(plainKey)
  if (!record) {
    return sendAuthError(event, 401, 'Invalid API Key')
  }

  if (record.monthly_limit > 0 && record.tokens_used >= record.monthly_limit) {
    return sendAuthError(event, 429, `Monthly token quota (${record.monthly_limit}) exceeded.`, 'quota_exceeded')
  }

  const body = await readBody(event).catch(() => ({}))
  const model = body?.model || ''
  if (model && !checkAccess(record, model)) {
    return sendAuthError(event, 403, `Model "${model}" is not allowed for this API key.`, 'access_denied')
  }

  event.context._apiKeyRecord = record
})

function extractApiKey(event: H3Event): string {
  const authHeader = getHeader(event, 'Authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7).trim()
  return (getHeader(event, 'X-API-Key') || '').trim()
}

function checkAccess(record: any, model: string): boolean {
  const hasProvider = record.allowed_providers?.length > 0
  const hasModel = record.allowed_models?.length > 0
  if (!hasProvider && !hasModel) return true
  if (hasModel && record.allowed_models.includes(model)) return true
  if (hasProvider) {
    const slash = model.indexOf('/')
    if (slash > 0 && record.allowed_providers.includes(model.slice(0, slash))) return true
  }
  return false
}

function sendAuthError(event: H3Event, status: number, message: string, code = 'invalid_api_key') {
  setResponseStatus(event, status)
  setResponseHeader(event, 'Content-Type', 'application/json')
  return send(event, JSON.stringify({ error: { message, type: 'authentication_error', code } }))
}
