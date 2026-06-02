import { getHeader, createError, readBody } from 'h3'
import type { H3Event } from 'h3'
import { getAuthStore } from '../stores/auth.store'

export default defineEventHandler(async (event: H3Event) => {
  if (!event.path.startsWith('/api/openai')) return

  const store = getAuthStore()
  const keys = await store.listKeys()
  if (keys.length === 0) return // bootstrap mode

  const plainKey = extractApiKey(event)
  const record = await store.getKeyRecord(plainKey)
  if (!record) {
    throw authError('Invalid API Key')
  }

  // Monthly quota check (0 = unlimited)
  if (record.monthly_limit > 0 && record.tokens_used >= record.monthly_limit) {
    throw createError({
      statusCode: 429,
      statusMessage: 'Quota Exceeded',
      data: { error: { message: `Monthly token quota (${record.monthly_limit}) exceeded.`, type: 'quota_exceeded' } }
    })
  }

  // Model access check
  const body = await readBody(event).catch(() => ({}))
  const model = body?.model || ''
  if (model) {
    if (!checkAccess(record, model)) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: { error: { message: `Model "${model}" is not allowed for this API key.`, type: 'access_denied' } }
      })
    }
  }

  // Attach record to event context for post-request usage tracking
  event.context._apiKeyRecord = record
})

function extractApiKey(event: H3Event): string {
  const authHeader = getHeader(event, 'Authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7).trim()
  return (getHeader(event, 'X-API-Key') || '').trim()
}

function checkAccess(record: any, model: string): boolean {
  // Empty lists = allow all
  const hasProvider = record.allowed_providers?.length > 0
  const hasModel = record.allowed_models?.length > 0
  if (!hasProvider && !hasModel) return true

  if (hasModel && record.allowed_models.includes(model)) return true

  // Check provider-level: model format is "provider/name"
  if (hasProvider) {
    const slash = model.indexOf('/')
    if (slash > 0) {
      const provider = model.slice(0, slash)
      if (record.allowed_providers.includes(provider)) return true
    }
  }

  return false
}

function authError(msg: string) {
  return createError({
    statusCode: 401,
    statusMessage: 'Unauthorized',
    data: { error: { message: msg, type: 'authentication_error', code: 'invalid_api_key' } }
  })
}
