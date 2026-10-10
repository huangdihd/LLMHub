import { getHeader } from 'h3'
import { getAuthStore } from '../stores/auth.store'
import { requestHooks, type AdmissionContext } from '../core/hooks'
import { extractIngressKey, ingressModel, ingressProtocol, missingKeyMessage, sendAdmissionError } from '../protocols/admission'

export default defineEventHandler(async event => {
  const protocol = ingressProtocol(event)
  if (!protocol) return

  const store = getAuthStore()
  const plainKey = extractIngressKey(event, protocol)
  const context: AdmissionContext = { event, incomingProtocol: protocol, model: '' }
  if (event.method === 'POST') {
    const rejection = await requestHooks.admission('onBeforeIdentity', context)
    if (rejection) return sendAdmissionError(event, rejection)
  }

  let record = null
  if (!plainKey) {
    const token = getCookie(event, 'llmhub_session') || ''
    if (!token || !await store.validateSession(token)) {
      return sendAdmissionError(event, { status: 401, message: missingKeyMessage(protocol), code: 'invalid_api_key' })
    }
    const impersonateId = getHeader(event, 'X-LLMHub-Key-ID')
    if (impersonateId) record = await store.getKeyById(impersonateId)
    if (!record) {
      // An absent or unknown impersonation target retains full administrator access.
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
    if (!record) return sendAdmissionError(event, { status: 401, message: 'Invalid API Key', code: 'invalid_api_key' })
  }

  context.apiKeyRecord = record
  if (event.method === 'POST') {
    const rejection = await requestHooks.admission('onAfterIdentity', context)
    if (rejection) return sendAdmissionError(event, rejection)
    const source = await ingressModel(event, protocol)
    context.model = source.model
    if (context.model) {
      const modelRejection = await requestHooks.admission('onModelResolved', context)
      // Body fallback rewrites historically remain visible even when access fails.
      if (protocol !== 'gemini') source.replace(context.model)
      if (modelRejection) return sendAdmissionError(event, modelRejection)
    }
    source.replace(context.model)
  }
  event.context._apiKeyRecord = record
})
