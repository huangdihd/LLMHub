import { ProviderManager } from '../../../providers/manager'
import { RequestPipeline } from '../../../core/pipeline'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const manager = new ProviderManager()
  await manager.loadProviders()

  const pipeline = new RequestPipeline(manager, event, 'openai-chat')
  try {
    const parser = manager.getParser('/v1/chat/completions', 'POST', body)
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

        try {
          const serializer = manager.getSerializer('openai-chat')

          const blockIndexToToolIndex = new Map<number, number>()
          let nextToolIndex = 0
          let doneSent = false
          let doneMarkerSent = false
          let pendingDone: any = null
          let hasContentOrToolCall = false

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
                  if (!doneSent && !hasContentOrToolCall) {
                    // Ensure assistant message always has content or tool_calls
                    const stub = serializer!.serializeStreamChunk({ type: 'content', delta: '' })
                    event.node.res.write(`data: ${JSON.stringify(stub)}\n\n`)
                  }
                  if (doneSent) {
                    const u = (unifiedChunk as any).usage
                    if (u) pipeline.trackUsage(u, request.model)
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
                } else if (unifiedChunk.type !== 'content' || unifiedChunk.delta) {
                  if (unifiedChunk.type === 'content' || unifiedChunk.type === 'tool_call') {
                    hasContentOrToolCall = true
                  }
                  const serializedChunk = serializer!.serializeStreamChunk(unifiedChunk)
                  event.node.res.write(`data: ${JSON.stringify(serializedChunk)}\n\n`)
                }
              }
            },
            onDoneMarker: () => {
              emitDone(pendingDone || { type: 'done' })
              emitDoneMarker()
            },
            onChunkError: (e) => {
              console.error('[LLMHub] openai/chat: failed to process stream chunk, dropping it:', e)
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

      const serializer = manager.getSerializer('openai-chat')
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
