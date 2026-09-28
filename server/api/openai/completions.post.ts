import { ProviderManager } from '../../providers/manager'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const manager = new ProviderManager()
  await manager.loadProviders()

  const parser = manager.getParser('/v1/completions', 'POST', body)
  if (!parser) {
    throwFormattedError(manager.buildGatewayError('Invalid request', 400))
  }

  const request = parser.parseRequest(body)

  try {
    incrementCalls().catch(() => {})
    const resolved = manager.resolveAdapter(request.model || '', 'openai-completion', request.stream)
    const adapter = resolved?.adapter

    if (request.stream && adapter) {
      const providerRequest = adapter.toProviderRequest({ ...request, stream: true })
      const stream = await adapter.callStream(providerRequest)

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
        const serializer = manager.getSerializer('openai-completion')
        const reader = stream.getReader()
        const decoder = new TextDecoder()

        let lineBuffer = ''
        let providerState = {}
        let doneSent = false
        let doneMarkerSent = false
        let pendingDone: any = null

        const emitDone = (chunk: any) => {
          if (doneSent) return
          doneSent = true
          const u = chunk.usage
          if (u) trackUsage(event, u, request.model)
          const serializedChunk = serializer!.serializeStreamChunk(chunk)
          event.node.res.write(`data: ${JSON.stringify(serializedChunk)}\n\n`)
        }

        const emitDoneMarker = () => {
          if (doneMarkerSent) return
          doneMarkerSent = true
          event.node.res.write('data: [DONE]\n\n')
        }

        const processLine = (line: string) => {
          if (!line.startsWith('data: ')) return
          const data = line.slice(6).trim()
          if (data === '[DONE]') {
            emitDone(pendingDone || { type: 'done' })
            emitDoneMarker()
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
                  if (unifiedChunk.usage) trackUsage(event, unifiedChunk.usage, request.model)
                  continue
                }
                if (!unifiedChunk.usage) {
                  // OpenAI-compatible providers may send finish_reason first and
                  // usage in a later choices: [] chunk. Hold completion until then.
                  pendingDone = unifiedChunk
                  continue
                }
                emitDone({ ...pendingDone, ...unifiedChunk })
                pendingDone = null
              } else if (unifiedChunk.type === 'content' && unifiedChunk.delta) {
                const serializedChunk = serializer!.serializeStreamChunk(unifiedChunk)
                event.node.res.write(`data: ${JSON.stringify(serializedChunk)}\n\n`)
              }
              // thinking / tool_call chunks have no representation in legacy completions
            }
          } catch (e) {
            console.error('[LLMHub] openai/completions: failed to process stream chunk, dropping it:', e)
          }
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

        emitDone(pendingDone || { type: 'done' })
        emitDoneMarker()
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

    const serializer = manager.getSerializer('openai-completion')
    if (!serializer) {
      throw manager.buildGatewayError('Serializer not found', 500)
    }

    const u = response.usage
    trackUsage(event, u || 0, request.model)
    return serializer.serializeResponse(response)
  } catch (error: any) {
    throwFormattedError(error)
  }
})
