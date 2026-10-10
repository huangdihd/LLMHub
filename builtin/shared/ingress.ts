import { getHeader, readBody, send, setResponseHeader, setResponseStatus } from 'h3'
import type { H3Event } from 'h3'
import type { AdmissionRejection } from '../../server/core/hooks'

export function extractBearerKey(event: H3Event): string {
  const authorization = getHeader(event, 'Authorization')
  return authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
}

export function extractBodyKey(event: H3Event): string {
  const authorization = getHeader(event, 'Authorization')
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7).trim()
  return (getHeader(event, 'X-API-Key') || '').trim()
}

export async function extractBodyModel(event: H3Event) {
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
