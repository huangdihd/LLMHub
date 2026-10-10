import { ProviderManager } from '../../providers/manager'
import { RequestPipeline } from '../../core/pipeline'
import { OpenAIResponsesSerializer } from '../../protocols/openai-responses-serializer'
import type { ResponsesStreamEvent } from '../../protocols/openai-responses-serializer'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const manager = new ProviderManager()
  await manager.loadProviders()

  const pipeline = new RequestPipeline(manager, event, 'openai-responses')
  try {
    const parser = manager.getParser('/v1/responses', 'POST', body)
    if (!parser) {
      throwFormattedError(manager.buildGatewayError('Invalid request', 400))
    }

    try {
      let request = parser.parseRequest(body)
      pipeline.incrementCalls().catch(() => {})
      const prepared = await pipeline.prepare(request)
      request = prepared.request
      const resolved = prepared.resolved
      const adapter = resolved?.adapter

      if (request.stream && adapter) {
        const stream = await pipeline.openStream(request, adapter)

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

          let doneSent = false
          let pendingDone: any = null

          const emitDone = (chunk: any) => {
            if (doneSent) return
            doneSent = true
            const u = chunk.usage
            pipeline.trackUsage(u || 0, request.model)
            writeEvents(serializer.serializeStreamChunk(chunk))
          }

          await pipeline.consumeStream(stream, adapter, {
            onChunks: (unifiedChunks) => {
              for (const unifiedChunk of unifiedChunks) {
                if (unifiedChunk.type === 'done') {
                  if (doneSent) {
                    if (unifiedChunk.usage) pipeline.trackUsage(unifiedChunk.usage, request.model)
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
            },
            onDoneMarker: () => {
              emitDone(pendingDone || { type: 'done' })
            },
            onChunkError: (e) => {
              console.error('[LLMHub] openai/responses: failed to process stream chunk, dropping it:', e)
            }
          })

          // Upstream ended without a terminal marker — still close the response.
          emitDone(pendingDone || { type: 'done' })
        } catch (streamError: any) {
          await pipeline.error(streamError)
          const resp = formatErrorResponse(streamError)
          writeEvents([serializer.errorEvent(resp.error?.message || 'Stream error', resp.error?.code || null)])
        } finally {
          clearInterval(keepAliveTimer)
          event.node.res.end()
        }

        return
      }

      const response = await pipeline.call(request)

      const serializer = new OpenAIResponsesSerializer(request.config?.outputFormat)

      const u = response.usage
      pipeline.trackUsage(u || 0, request.model)
      return serializer.serializeResponse(response)
    } catch (error: any) {
      await pipeline.error(error)
      throwFormattedError(error)
    }
  } catch (error) {
    await pipeline.error(error)
    throw error
  } finally {
    await pipeline.complete()
  }
})
