import { ProviderManager } from '../../../providers/manager'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const manager = new ProviderManager()
  await manager.loadProviders()

  const parser = manager.getParser('/v1/chat/completions', 'POST', body)
  if (!parser) {
    throwFormattedError(manager.buildGatewayError('Invalid request', 400))
  }

  const request = parser.parseRequest(body)

  try {
    incrementCalls().catch(() => {})
    const resolved = manager.resolveAdapter(request.model || '', 'openai-chat', request.stream)
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
        const serializer = manager.getSerializer('openai-chat')
        const stream = adapter.callStream(providerRequest)
        const reader = stream.getReader()
        const decoder = new TextDecoder()

        let lineBuffer = ''
        const blockIndexToToolIndex = new Map<number, number>()
        let nextToolIndex = 0
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
            event.node.res.write('data: [DONE]\n\n')
            return
          }
          if (!data) return
          try {
            const originalChunk = JSON.parse(data)
            const unifiedChunksRaw = adapter!.fromProviderStreamChunk(originalChunk, providerState)
            const unifiedChunks = Array.isArray(unifiedChunksRaw) ? unifiedChunksRaw : [unifiedChunksRaw]

            for (const unifiedChunk of unifiedChunks) {
              if (unifiedChunk.type === 'tool_call' && unifiedChunk.toolCall) {
                const tc = unifiedChunk.toolCall
                const blockIndex = tc.index
                if (blockIndex !== undefined) {
                  if (!blockIndexToToolIndex.has(blockIndex)) {
                    blockIndexToToolIndex.set(blockIndex, nextToolIndex++)
                  }
                  unifiedChunk.toolCall.index = blockIndexToToolIndex.get(blockIndex)
                }
              }

              if (unifiedChunk.type === 'done') {
                if (doneSent) {
                  // Provider may split usage into a separate chunk — still capture
                  const u = (unifiedChunk as any).usage
                  if (u) trackUsage(event, (u.promptTokens || 0) + (u.completionTokens || 0), request.model)
                  return
                }
                doneSent = true
                // Track token usage from the final chunk
                const u = (unifiedChunk as any).usage
                if (u) trackUsage(event, (u.promptTokens || 0) + (u.completionTokens || 0), request.model)
                const serializedChunk = serializer!.serializeStreamChunk(unifiedChunk)
                event.node.res.write(`data: ${JSON.stringify(serializedChunk)}\n\n`)
                event.node.res.write('data: [DONE]\n\n')
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
