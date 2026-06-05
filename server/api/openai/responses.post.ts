import { ProviderManager } from '../../providers/manager'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const manager = new ProviderManager()
  await manager.loadProviders()

  const parser = manager.getParser('/v1/responses', 'POST', body)
  if (!parser) {
    throwFormattedError(manager.buildGatewayError('Invalid request', 400))
  }

  const request = parser.parseRequest(body)

  try {
    incrementCalls().catch(() => {})
    const resolved = manager.resolveAdapter(request.model || '', 'openai-responses', request.stream)
    const adapter = resolved?.adapter

    if (request.stream && adapter) {
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
        const decoder = new TextDecoder()
        let buffer = ''
        let streamUsage: any = null

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || !trimmed.startsWith('data: ')) {
              event.node.res.write(line + '\n')
              continue
            }
            const data = trimmed.slice(6).trim()
            if (data === '[DONE]') {
              event.node.res.write('data: [DONE]\n\n')
              continue
            }
            if (!data) continue

            try {
              const chunk = JSON.parse(data)
              if (chunk.usage) streamUsage = chunk.usage
            } catch (e) {}

            event.node.res.write(`data: ${data}\n\n`)
          }
        }

        if (buffer.trim() && buffer.trim().startsWith('data: ')) {
          const d = buffer.trim().slice(6).trim()
          if (d !== '[DONE]') {
            try {
              const chunk = JSON.parse(d)
              if (chunk.usage) streamUsage = chunk.usage
            } catch (e) {}
          }
          event.node.res.write(`data: ${d}\n\n`)
        }

        if (streamUsage) {
          trackUsage(event, (streamUsage.prompt_tokens || 0) + (streamUsage.completion_tokens || streamUsage.total_tokens || 0), request.model)
        } else {
          trackUsage(event, 0, request.model)
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

    const serializer = manager.getSerializer('openai-chat')
    if (!serializer) {
      throw manager.buildGatewayError('Serializer not found', 500)
    }

    const u = response.usage
    trackUsage(event, (u?.promptTokens || 0) + (u?.completionTokens || 0), request.model)
    return serializer.serializeResponse(response)
  } catch (error: any) {
    throwFormattedError(error)
  }
})
