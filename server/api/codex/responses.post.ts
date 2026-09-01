import { ProviderManager } from '../../providers/manager'
import { CodexResponsesSerializer } from '../../protocols/codex-responses-serializer'
import type { ResponsesStreamEvent } from '../../protocols/openai-responses-serializer'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const manager = new ProviderManager()
  await manager.loadProviders()

  const parser = manager.getParser('/codex/responses', 'POST', body)
  if (!parser) throwFormattedError(manager.buildGatewayError('Invalid request', 400))
  const request = parser.parseRequest(body)

  try {
    incrementCalls().catch(() => {})
    const resolved = manager.resolveAdapter(request.model || '', 'codex-responses', request.stream)
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
        if (!event.node.res.writableEnded) event.node.res.write(': ping\n\n')
      }, 15000)
      const serializer = new CodexResponsesSerializer()
      const writeEvents = (events: ResponsesStreamEvent[]) => {
        for (const item of events) {
          event.node.res.write(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`)
        }
      }
      writeEvents(serializer.startEvents())

      try {
        const reader = adapter.callStream(providerRequest).getReader()
        const decoder = new TextDecoder()
        let lineBuffer = ''
        let providerState = {}
        let doneSent = false

        const processLine = (line: string) => {
          if (!line.trimStart().startsWith('data:')) return
          const data = line.trimStart().slice(5).trim()
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
            const upstream = JSON.parse(data)
            const normalized = adapter.fromProviderStreamChunk(upstream, providerState)
            const chunks = Array.isArray(normalized) ? normalized : [normalized]
            for (const chunk of chunks) {
              if (chunk.type === 'done') {
                const usage = chunk.usage
                if (usage) {
                  trackUsage(event, usage.promptTokens + usage.completionTokens, request.model)
                }
                if (doneSent) continue
                doneSent = true
                if (!usage) trackUsage(event, 0, request.model)
                writeEvents(serializer.serializeStreamChunk(chunk))
              } else if ((chunk.type !== 'content' && chunk.type !== 'thinking') || chunk.delta || chunk.encryptedContent) {
                writeEvents(serializer.serializeStreamChunk(chunk))
              }
            }
          } catch (error) {
            console.error('[LLMHub] codex/responses: failed to process stream chunk:', error)
          }
        }

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          lineBuffer += decoder.decode(value, { stream: true })
          const lines = lineBuffer.split(/\r?\n/)
          lineBuffer = lines.pop() || ''
          for (const line of lines) processLine(line)
        }
        if (lineBuffer.trim()) processLine(lineBuffer)
        if (!doneSent) {
          trackUsage(event, 0, request.model)
          writeEvents(serializer.serializeStreamChunk({ type: 'done' }))
        }
      } catch (streamError: any) {
        const response = formatErrorResponse(streamError)
        event.node.res.write(`event: error\ndata: ${JSON.stringify({
          type: 'error',
          code: response.error?.code || null,
          message: response.error?.message || 'Stream error',
          param: null
        })}\n\n`)
      } finally {
        clearInterval(keepAliveTimer)
        event.node.res.end()
      }
      return
    }

    const response = await manager.callLLM(request)
    const serializer = manager.getSerializer('codex-responses')
    if (!serializer) throw manager.buildGatewayError('Serializer not found', 500)
    trackUsage(
      event,
      (response.usage?.promptTokens || 0) + (response.usage?.completionTokens || 0),
      request.model
    )
    return serializer.serializeResponse(response)
  } catch (error: any) {
    throwFormattedError(error)
  }
})
