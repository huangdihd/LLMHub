import { ProviderManager } from '../../../../../providers/manager'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const manager = new ProviderManager()
  await manager.loadProviders()

  const params = event.context.params || {}
  const modelFromUrl = params.model ? decodeURIComponent(params.model) : undefined

  // Use resolved fallback model if set by auth middleware
  const resolvedModel = (event as any).context?._resolvedModel

  // Build the full model ID with provider prefix from body
  const fullModel = (resolvedModel && resolvedModel !== modelFromUrl) ? resolvedModel : (body.model || modelFromUrl)

  let request
  try {
    const parser = manager.getParser('/models/X:generateContent', 'POST', body)
    if (!parser) {
      throwFormattedError(manager.buildGatewayError('Invalid request', 400))
    }
    request = (parser as any).parseRequest(body, fullModel)
  } catch (parseError: any) {
    throwFormattedError(manager.buildGatewayError(`Parse error: ${parseError.message}`, 400))
  }

  // Use the full model ID (with provider prefix) for routing
  if (!request.model && fullModel) {
    request.model = fullModel
  }

  try {
    incrementCalls().catch(() => {})
    const response = await manager.callLLM(request)

    const serializer = manager.getSerializer('gemini-generate')
    if (!serializer) {
      throwFormattedError(manager.buildGatewayError('Serializer not found', 500))
    }

    const u = response.usage
    trackUsage(event, (u?.promptTokens || 0) + (u?.completionTokens || 0), request.model)
    return serializer.serializeResponse(response)
  } catch (error: any) {
    throwFormattedError(error)
  }
})
