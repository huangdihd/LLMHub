import { ProviderManager } from '../../providers/manager'
import { RequestPipeline } from '../../core/pipeline'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const manager = new ProviderManager()
  await manager.loadProviders()

  const pipeline = new RequestPipeline(manager, event, 'openai-completion')
  try {
    const parser = manager.getParser('/v1/completions', 'POST', body)
    if (!parser) {
      throwFormattedError(manager.buildGatewayError('Invalid request', 400))
    }

    let request = parser.parseRequest(body)

    try {
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

        try {
          const serializer = manager.getSerializer('openai-completion')

          let doneSent = false
          let doneMarkerSent = false
          let pendingDone: any = null

          const emitDone = (chunk: any) => {
            if (doneSent) return
            doneSent = true
            const u = chunk.usage
            if (u) pipeline.trackUsage(u, request.model)
            const serializedChunk = serializer!.serializeStreamChunk(chunk)
            event.node.res.write(`data: ${JSON.stringify(serializedChunk)}\n\n`)
          }

          const emitDoneMarker = () => {
            if (doneMarkerSent) return
            doneMarkerSent = true
            event.node.res.write('data: [DONE]\n\n')
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
                } else if (unifiedChunk.type === 'content' && unifiedChunk.delta) {
                  const serializedChunk = serializer!.serializeStreamChunk(unifiedChunk)
                  event.node.res.write(`data: ${JSON.stringify(serializedChunk)}\n\n`)
                }
                // thinking / tool_call chunks have no representation in legacy completions
              }
            },
            onDoneMarker: () => {
              emitDone(pendingDone || { type: 'done' })
              emitDoneMarker()
            },
            onChunkError: (e) => {
              console.error('[LLMHub] openai/completions: failed to process stream chunk, dropping it:', e)
            }
          })

          emitDone(pendingDone || { type: 'done' })
          emitDoneMarker()
        } catch (streamError: any) {
          await pipeline.error(streamError)
          const resp = formatErrorResponse(streamError)
          event.node.res.write(`data: ${JSON.stringify(resp)}\n\n`)
        } finally {
          clearInterval(keepAliveTimer)
          event.node.res.end()
        }

        return
      }

      const response = await pipeline.call(request)

      const serializer = manager.getSerializer('openai-completion')
      if (!serializer) {
        throw manager.buildGatewayError('Serializer not found', 500)
      }

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
