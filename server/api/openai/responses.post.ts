import { ProviderManager } from '../../providers/manager'
import { OpenAIResponsesSerializer } from '../../protocols/openai-responses-serializer'
import type { ResponsesStreamEvent } from '../../protocols/openai-responses-serializer'

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

      // Streaming serialization is stateful (item ids, output_index, sequence_number)
      const serializer = new OpenAIResponsesSerializer()
      const writeEvents = (events: ResponsesStreamEvent[]) => {
        for (const e of events) {
          event.node.res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
        }
      }

      writeEvents(serializer.startEvents())

      try {
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
              trackUsage(event, 0, request.model)
              writeEvents(serializer.serializeStreamChunk({ type: 'done' }))
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
                const u = unifiedChunk.usage
                if (u) trackUsage(event, (u.promptTokens || 0) + (u.completionTokens || 0), request.model)
                if (doneSent) continue
                doneSent = true
                if (!u) trackUsage(event, 0, request.model)
                writeEvents(serializer.serializeStreamChunk(unifiedChunk))
              } else if ((unifiedChunk.type !== 'content' && unifiedChunk.type !== 'thinking') || unifiedChunk.delta) {
                writeEvents(serializer.serializeStreamChunk(unifiedChunk))
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

        // Upstream ended without a terminal chunk — still close the response
        if (!doneSent) {
          doneSent = true
          trackUsage(event, 0, request.model)
          writeEvents(serializer.serializeStreamChunk({ type: 'done' }))
        }
      } catch (streamError: any) {
        const resp = formatErrorResponse(streamError)
        event.node.res.write(`event: error\ndata: ${JSON.stringify({
          type: 'error',
          code: resp.error?.code || null,
          message: resp.error?.message || 'Stream error',
          param: null
        })}\n\n`)
      } finally {
        clearInterval(keepAliveTimer)
        event.node.res.end()
      }

      return
    }

    const response = await manager.callLLM(request)

    const serializer = manager.getSerializer('openai-responses')
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
