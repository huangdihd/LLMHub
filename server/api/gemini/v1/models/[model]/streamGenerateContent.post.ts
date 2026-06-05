import { ProviderManager } from '../../../../../providers/manager'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const manager = new ProviderManager()
  await manager.loadProviders()

  const params = event.context.params || {}
  const modelFromUrl = params.model ? decodeURIComponent(params.model) : undefined

  // Use resolved fallback model if set by auth middleware
  const resolvedModel = (event as any).context?._resolvedModel

  const fullModel = (resolvedModel && resolvedModel !== modelFromUrl) ? resolvedModel : (body.model || modelFromUrl)

  let request
  try {
    const parser = manager.getParser('/models/X:streamGenerateContent', 'POST', body)
    if (!parser) {
      throwFormattedError(manager.buildGatewayError('Invalid request', 400))
    }
    request = (parser as any).parseRequest(body, fullModel)
  } catch (parseError: any) {
    throwFormattedError(manager.buildGatewayError(`Parse error: ${parseError.message}`, 400))
  }

  if (!request.model && fullModel) {
    request.model = fullModel
  }

  request.stream = true

  try {
    incrementCalls().catch(() => {})
    const resolved = manager.resolveAdapter(request.model || '', 'gemini-generate', true)
    if (!resolved) {
      throwFormattedError(manager.buildGatewayError(`No adapter found for model: ${request.model}`, 404))
    }

    const adapter = resolved.adapter
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
      const serializer = manager.getSerializer('gemini-generate')
      const stream = adapter.callStream(providerRequest)
      const reader = stream.getReader()
      const decoder = new TextDecoder()

      let lineBuffer = ''
      let providerState = {}
      let doneSent = false

      const processLine = (line: string) => {
        if (!line.startsWith('data: ')) return
        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          if (!doneSent) {
            doneSent = true
            const doneChunk = serializer!.serializeStreamChunk({ type: 'done' })
            event.node.res.write(`data: ${JSON.stringify(doneChunk)}\n\n`)
          }
          return
        }
        if (!data) return
        try {
          const originalChunk = JSON.parse(data)
          const unifiedChunksRaw = adapter!.fromProviderStreamChunk(originalChunk, providerState)
          const unifiedChunks = Array.isArray(unifiedChunksRaw) ? unifiedChunksRaw : [unifiedChunksRaw]

          for (const unifiedChunk of unifiedChunks) {
            if (unifiedChunk.type === 'done') {
              if (doneSent) {
                const u = (unifiedChunk as any).usage
                if (u) trackUsage(event, (u.promptTokens || 0) + (u.completionTokens || 0), request.model)
                return
              }
              doneSent = true
              const u = (unifiedChunk as any).usage
              if (u) trackUsage(event, (u.promptTokens || 0) + (u.completionTokens || 0), request.model)
              const serializedChunk = serializer!.serializeStreamChunk(unifiedChunk)
              event.node.res.write(`data: ${JSON.stringify(serializedChunk)}\n\n`)
            } else if (unifiedChunk.type !== 'content' || unifiedChunk.delta) {
              const serializedChunk = serializer!.serializeStreamChunk(unifiedChunk)
              event.node.res.write(`data: ${JSON.stringify(serializedChunk)}\n\n`)
            }
          }
        } catch (e) {}
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        lineBuffer += decoder.decode(value, { stream: true })
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() || ''
        for (const line of lines) {
          processLine(line)
        }
      }

      if (lineBuffer.trim()) processLine(lineBuffer.trim())

    } catch (streamError: any) {
      if (!event.node.res.headersSent) {
        throwFormattedError(manager.buildGatewayError(streamError.message, 500))
      } else {
        event.node.res.write(`data: ${JSON.stringify({ error: { message: streamError.message } })}\n\n`)
      }
    } finally {
      clearInterval(keepAliveTimer)
      if (!event.node.res.writableEnded) {
        event.node.res.end()
      }
    }

    return
  } catch (error: any) {
    throwFormattedError(error)
  }
})
