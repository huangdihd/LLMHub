import { getHeader, readBody, setResponseStatus, setResponseHeader, send } from 'h3'
import type { H3Event } from 'h3'
import { getAuthStore } from '../stores/auth.store'

export default defineEventHandler(async (event: H3Event) => {
  if (!event.path.startsWith('/api/gemini')) return

  const store = getAuthStore()
  const plainKey = extractApiKey(event)
  let record: any = null

  if (!plainKey) {
    const token = getCookie(event, 'llmhub_session') || ''
    if (token && (await store.validateSession(token))) {
      const impersonateId = getHeader(event, 'X-LLMHub-Key-ID')
      if (impersonateId) {
        record = await store.getKeyById(impersonateId)
      }

      if (!record) {
        event.context._apiKeyRecord = {
          name: 'Gateway Session',
          tokens_used: 0,
          monthly_limit: 0,
          allowed_providers: [],
          allowed_models: []
        }
        return
      }
    } else {
      return sendAuthError(event, 401, 'API Key required. Provide via x-goog-api-key header, Authorization: Bearer <key>, or ?key=<key> query parameter.')
    }
  } else {
    record = await store.getKeyRecord(plainKey)
    if (!record) {
      return sendAuthError(event, 401, 'Invalid API Key')
    }
  }

  if (event.method === 'POST' && record.monthly_limit > 0 && record.tokens_used >= record.monthly_limit) {
    return sendAuthError(event, 429, `Monthly token quota (${record.monthly_limit}) exceeded.`, 'quota_exceeded')
  }

  if (event.method === 'POST') {
    const url = getRequestURL(event).pathname
    const modelMatch = url.match(/\/models\/([^/:]+)/)
    const model = modelMatch ? decodeURIComponent(modelMatch[1]) : ''
    if (model && !checkAccess(record, model)) {
      return sendAuthError(event, 403, `Model "${model}" is not allowed for this API key.`, 'access_denied')
    }
  }

  event.context._apiKeyRecord = record
})

function extractApiKey(event: H3Event): string {
  const googKey = getHeader(event, 'x-goog-api-key')
  if (googKey) return googKey.trim()

  const authHeader = getHeader(event, 'Authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7).trim()

  const url = getRequestURL(event)
  const keyParam = url.searchParams.get('key')
  if (keyParam) return keyParam.trim()

  return ''
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
  return send(event, JSON.stringify({ error: { message, code } }))
}
