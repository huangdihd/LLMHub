import { getHeader, getRequestURL } from 'h3'
import type { IngressDefinition } from '../../server/core/ingress-registry'
import { extractBearerKey, sendAdmissionError } from '../shared/ingress'

export const ingress: IngressDefinition = {
  id: 'gemini',
  pathPrefix: '/api/gemini',
  extractKey(event) {
    const key = getHeader(event, 'x-goog-api-key')
    return key ? key.trim() : extractBearerKey(event)
  },
  missingKeyMessage: 'API Key required. Provide via x-goog-api-key header or Authorization: Bearer <key>.',
  async extractModel(event) {
    const match = getRequestURL(event).pathname.match(/\/models\/(.+):(generateContent|streamGenerateContent|embedContent|batchEmbedContents)/)
    return {
      model: match ? decodeURIComponent(match[1]) : '',
      replace(model: string) { event.context._resolvedModel = model }
    }
  },
  rewriteBeforeRejection: false,
  sendError: sendAdmissionError
}
