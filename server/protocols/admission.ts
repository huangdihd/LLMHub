import { getHeader, getRequestURL, readBody, send, setResponseHeader, setResponseStatus } from 'h3'
import type { H3Event } from 'h3'
import type { AdmissionRejection } from '../core/hooks'

export function ingressProtocol(event: H3Event): string | undefined {
  return ['openai', 'claude', 'gemini'].find(protocol => event.path.startsWith(`/api/${protocol}`))
}

export function extractIngressKey(event: H3Event, protocol: string): string {
  if (protocol === 'gemini') {
    const key = getHeader(event, 'x-goog-api-key')
    if (key) return key.trim()
  }
  const authorization = getHeader(event, 'Authorization')
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7).trim()
  return protocol === 'gemini' ? '' : (getHeader(event, 'X-API-Key') || '').trim()
}

export function missingKeyMessage(protocol: string): string {
  return protocol === 'gemini'
    ? 'API Key required. Provide via x-goog-api-key header or Authorization: Bearer <key>.'
    : 'API Key required. Provide via Authorization: Bearer <key> or X-API-Key header.'
}

export async function ingressModel(event: H3Event, protocol: string) {
  if (protocol === 'gemini') {
    const match = getRequestURL(event).pathname.match(/\/models\/(.+):(generateContent|streamGenerateContent|embedContent|batchEmbedContents)/)
    return {
      model: match ? decodeURIComponent(match[1]) : '',
      replace(model: string) { event.context._resolvedModel = model }
    }
  }
  const body = await readBody(event).catch(() => ({}))
  const originalModel = body?.model || ''
  return {
    model: originalModel,
    replace(model: string) { if (model !== originalModel) body.model = model }
  }
}

export function sendAdmissionError(event: H3Event, rejection: AdmissionRejection) {
  setResponseStatus(event, rejection.status)
  setResponseHeader(event, 'Content-Type', 'application/json')
  return send(event, JSON.stringify({ error: {
    message: rejection.message, type: 'authentication_error', code: rejection.code
  } }))
}
