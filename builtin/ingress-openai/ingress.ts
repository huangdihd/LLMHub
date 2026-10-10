import type { IngressDefinition } from '../../server/core/ingress-registry'
import { extractBodyKey, extractBodyModel, sendAdmissionError } from '../shared/ingress'

export const ingress: IngressDefinition = {
  id: 'openai',
  pathPrefix: '/api/openai',
  extractKey: extractBodyKey,
  missingKeyMessage: 'API Key required. Provide via Authorization: Bearer <key> or X-API-Key header.',
  extractModel: extractBodyModel,
  rewriteBeforeRejection: true,
  sendError: sendAdmissionError
}
