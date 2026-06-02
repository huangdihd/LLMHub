import { ProviderManager } from '../../../providers/manager'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const manager = new ProviderManager()
  await manager.loadProviders()

  const parser = manager.getParser('/v1/complete', 'POST', body)
  if (!parser) {
    throwFormattedError(manager.buildGatewayError('Invalid request', 400))
  }

  const request = parser.parseRequest(body)

  try {
    incrementCalls().catch(() => {})
    const resolved = manager.resolveAdapter(request.model || '', 'claude-completion', request.stream)
    const adapter = resolved?.adapter

    if (request.stream && adapter) {
      trackUsage(event, 0).catch(() => {})
      const providerRequest = adapter.toProviderRequest({ ...request, stream: true })

      setResponseHeaders(event, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      })

      event.node.res.flushHeaders()

      const keepAliveTimer = setInterval(() => {
        if (!event.node.res.writableEnded) {
          event.node.res.write(': ping\n\n')
        }
      }, 15000)

      try {
        const stream = adapter.callStream(providerRequest)
        const reader = stream.getReader()

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          event.node.res.write(value)
        }
      } catch (streamError: any) {
        const resp = formatErrorResponse(streamError)
        event.node.res.write(`data: ${JSON.stringify(resp)}\n\n`)
      } finally {
        clearInterval(keepAliveTimer)
        event.node.res.end()
      }

      return
    }

    const response = await manager.callLLM(request)

    const serializer = manager.getSerializer('claude-messages')
    if (!serializer) {
      throw manager.buildGatewayError('Serializer not found', 500)
    }

    const u = response.usage
    trackUsage(event, (u?.promptTokens || 0) + (u?.completionTokens || 0))
    return serializer.serializeResponse(response)
  } catch (error: any) {
    throwFormattedError(error)
  }
})
