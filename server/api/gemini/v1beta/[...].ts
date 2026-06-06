import { ProviderManager } from '../../../providers/manager'

function forwardUrl(event: any, v1Path: string) {
  const rawUrl = event.node.req.url || ''
  const qIdx = rawUrl.indexOf('?')
  event.node.req.url = qIdx >= 0 ? v1Path + rawUrl.slice(qIdx) : v1Path
}

export default defineEventHandler(async (event) => {
  const rawPath = event.context.params?._ || ''
  const method = event.method

  // GET /models — list available models
  if (method === 'GET' && rawPath === 'models') {
    forwardUrl(event, '/api/gemini/v1/models')
    const { default: handler } = await import('../v1/models.get')
    return handler(event)
  }

  // POST /models/{name}:generateContent — non-streaming
  if (method === 'POST' && rawPath.endsWith(':generateContent')) {
    const modelEncoded = rawPath.slice('models/'.length, -':generateContent'.length)
    forwardUrl(event, `/api/gemini/v1/models/${modelEncoded}/generateContent`)
    const { default: handler } = await import('../v1/models/[model]/generateContent.post')
    return handler(event)
  }

  // POST /models/{name}:streamGenerateContent — streaming
  if (method === 'POST' && rawPath.endsWith(':streamGenerateContent')) {
    const modelEncoded = rawPath.slice('models/'.length, -':streamGenerateContent'.length)
    forwardUrl(event, `/api/gemini/v1/models/${modelEncoded}/streamGenerateContent`)
    const { default: handler } = await import('../v1/models/[model]/streamGenerateContent.post')
    return handler(event)
  }

  throw createError({ statusCode: 404, statusMessage: `Page not found: /api/gemini/v1beta/${rawPath}` })
})
