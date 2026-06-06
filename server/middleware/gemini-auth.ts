import { getHeader, readBody, setResponseStatus, setResponseHeader, send, getRequestURL } from 'h3'
import type { H3Event } from 'h3'
import { getAuthStore } from '../stores/auth.store'
import { resolveFallbackModel } from '../utils/fallback'

export default defineEventHandler(async (event: H3Event) => {
  if (!event.path.startsWith('/api/gemini')) return

  const store = getAuthStore()
  const plainKey = extractApiKey(event)

  if (event.method === 'POST') {
    const bfConfig = await store.getBruteForceConfig()
    const clientIp = getClientIP(event, bfConfig)
    const rateCheck = await store.checkRateLimit(clientIp, bfConfig)
    if (!rateCheck.allowed) {
      return sendAuthError(event, 429, `Rate limit exceeded. Retry after ${rateCheck.retryAfter}s.`, 'rate_limit_exceeded')
    }
  }

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
          allowed_models: [],
          model_quotas: {},
          model_usage: {},
          provider_quotas: {},
          provider_usage: {},
          fallback_strategy: { enabled: false, name: 'auto', priority: [] }
        }
        return
      }
    } else {
      return sendAuthError(event, 401, 'API Key required. Provide via x-goog-api-key header or Authorization: Bearer <key>.')
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
    let model = modelMatch ? decodeURIComponent(modelMatch[1]) : ''

    if (model) {
      if (record.fallback_strategy?.enabled && model === record.fallback_strategy.name) {
        const result = resolveFallbackModel(record)
        if (result.exhausted) {
          return sendAuthError(event, 429, 'All fallback models exhausted.', 'fallback_exhausted')
        }
        if (result.resolved) model = result.resolved
      }

      if (!checkAccess(record, model)) {
        return sendAuthError(event, 403, `Model "${model}" is not allowed for this API key.`, 'access_denied')
      }

      const modelQuota = record.model_quotas?.[model] || 0
      if (modelQuota > 0) {
        const modelUsed = record.model_usage?.[model] || 0
        if (modelUsed >= modelQuota) {
          return sendAuthError(event, 429, `Model "${model}" quota (${modelQuota}) exceeded.`, 'model_quota_exceeded')
        }
      }

      const provider = model.includes('/') ? model.split('/')[0] : ''
      if (provider) {
        const providerQuota = record.provider_quotas?.[provider] || 0
        if (providerQuota > 0) {
          const providerUsed = record.provider_usage?.[provider] || 0
          if (providerUsed >= providerQuota) {
            return sendAuthError(event, 429, `Provider "${provider}" quota (${providerQuota}) exceeded.`, 'provider_quota_exceeded')
          }
        }
      }
    }

    // Store resolved model for handlers that extract model from URL
    event.context._resolvedModel = model
  }

  event.context._apiKeyRecord = record
})

function extractApiKey(event: H3Event): string {
  const googKey = getHeader(event, 'x-goog-api-key')
  if (googKey) return googKey.trim()

  const authHeader = getHeader(event, 'Authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7).trim()

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
  return send(event, JSON.stringify({ error: { message, type: 'authentication_error', code } }))
}

function getClientIP(event: H3Event, cfg: any): string {
  if (cfg.ip_header) {
    const val = getHeader(event, cfg.ip_header)
    if (val) return val.split(',')[0].trim()
  }
  return (event as any).context?.clientAddress || '127.0.0.1'
}
