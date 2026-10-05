import { ProviderManager } from '../../providers/manager'
import { applyThinkingPolicy } from '../../services/thinking-policy'
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

  try {
    const request = parser.parseRequest(body)
    incrementCalls().catch(() => {})
    const resolved = manager.resolveAdapter(request.model || '', 'openai-responses', request.stream)
    if (resolved) Object.assign(request, await applyThinkingPolicy(request, resolved.providerName))
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

      // Streaming serialization is stateful (item ids, output_index, sequence_number)
      const serializer = new OpenAIResponsesSerializer(request.config?.outputFormat)
      const writeEvents = (events: ResponsesStreamEvent[]) => {
        for (const e of events) {
          event.node.res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
        }
      }

      writeEvents(serializer.startEvents())

      try {
        const reader = stream.getReader()
        const decoder = new TextDecoder()

        let lineBuffer = ''
        let providerState = {}
        let doneSent = false
        let pendingDone: any = null

        const emitDone = (chunk: any) => {
          if (doneSent) return
          doneSent = true
          const u = chunk.usage
          trackUsage(event, u || 0, request.model)
          writeEvents(serializer.serializeStreamChunk(chunk))
        }

        const processLine = (line: string) => {
          if (!line.startsWith('data: ')) return
          const data = line.slice(6).trim()
          if (data === '[DONE]') {
            emitDone(pendingDone || { type: 'done' })
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
              } else if ((unifiedChunk.type !== 'content' && unifiedChunk.type !== 'thinking') || unifiedChunk.delta || unifiedChunk.encryptedContent || unifiedChunk.signature) {
                writeEvents(serializer.serializeStreamChunk(unifiedChunk))
              }
            }
          } catch (e) {
            console.error('[LLMHub] openai/responses: failed to process stream chunk, dropping it:', e)
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

        // Upstream ended without a terminal marker — still close the response.
        emitDone(pendingDone || { type: 'done' })
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

    const serializer = new OpenAIResponsesSerializer(request.config?.outputFormat)

    const u = response.usage
    trackUsage(event, u || 0, request.model)
    return serializer.serializeResponse(response)
  } catch (error: any) {
    throwFormattedError(error)
  }
})
