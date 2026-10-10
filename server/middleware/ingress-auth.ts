import { getHeader } from 'h3'
import { getAuthStore } from '../stores/auth.store'
import { requestHooks, type AdmissionContext } from '../core/hooks'
import { ingressRegistry } from '../core/ingress-registry'

export default defineEventHandler(async event => {
  const ingress = ingressRegistry.match(event.path)
  if (!ingress) return

  const store = getAuthStore()
  const plainKey = ingress.extractKey(event)
  const context: AdmissionContext = { event, incomingProtocol: ingress.id, model: '' }
  if (event.method === 'POST') {
    const rejection = await requestHooks.admission('onBeforeIdentity', context)
    if (rejection) return ingress.sendError(event, rejection)
  }

  let record = null
  if (!plainKey) {
    const token = getCookie(event, 'llmhub_session') || ''
    if (!token || !await store.validateSession(token)) {
      return ingress.sendError(event, { status: 401, message: ingress.missingKeyMessage, code: 'invalid_api_key' })
    }
    const impersonateId = getHeader(event, 'X-LLMHub-Key-ID')
    if (impersonateId) {
      record = await store.getKeyById(impersonateId)
      // An unknown target must not silently widen to administrator access.
      if (!record) return ingress.sendError(event, { status: 401, message: 'Invalid API Key', code: 'invalid_api_key' })
    }
    if (!record) {
      event.context._apiKeyRecord = {
        name: 'Gateway Session', tokens_used: 0, monthly_limit: 0,
        allowed_providers: [], allowed_models: [], model_quotas: {}, model_usage: {},
        provider_quotas: {}, provider_usage: {},
        fallback_strategy: { enabled: false, name: 'auto', priority: [] }
      }
      return
    }
  } else {
    record = await store.getKeyRecord(plainKey)
    if (!record) return ingress.sendError(event, { status: 401, message: 'Invalid API Key', code: 'invalid_api_key' })
  }

  context.apiKeyRecord = record
  if (event.method === 'POST') {
    const rejection = await requestHooks.admission('onAfterIdentity', context)
    if (rejection) return ingress.sendError(event, rejection)
    const source = await ingress.extractModel(event)
    context.model = source.model
    if (context.model) {
      const modelRejection = await requestHooks.admission('onModelResolved', context)
      // Body fallback rewrites historically remain visible even when access fails.
      if (ingress.rewriteBeforeRejection) source.replace(context.model)
      if (modelRejection) return ingress.sendError(event, modelRejection)
    }
    source.replace(context.model)
  }
  event.context._apiKeyRecord = record
})
