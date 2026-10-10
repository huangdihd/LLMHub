import { ProviderManager } from '../../../providers/manager'
import { RequestPipeline } from '../../../core/pipeline'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const manager = new ProviderManager()
  await manager.loadProviders()

  const pipeline = new RequestPipeline(manager, event, 'claude-completion')
  try {
    const parser = manager.getParser('/v1/complete', 'POST', body)
    if (!parser) {
      throwFormattedError(manager.buildGatewayError('Invalid request', 400))
    }

    let request = parser.parseRequest(body)

    try {
      pipeline.accountingComplete({ kind: 'attempt' }).catch(() => {})
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
            event.node.res.write(`event: ping\ndata: {"type":"ping"}\n\n`)
          }
        }, 15000)

        try {
          const serializer = manager.getSerializer('claude-completion')

          let doneSent = false

          const writeCompletion = (data: any) => {
            event.node.res.write(`event: completion\ndata: ${JSON.stringify(data)}\n\n`)
          }

          await pipeline.consumeStream(stream, adapter, {
            onChunks: (unifiedChunks) => {
              for (const unifiedChunk of unifiedChunks) {
                if (unifiedChunk.type === 'done') {
                  const u = unifiedChunk.usage
                  if (u) pipeline.accountingComplete({ kind: 'usage', usage: u, model: request.model })
                  if (doneSent) continue
                  doneSent = true
                  writeCompletion(serializer!.serializeStreamChunk(unifiedChunk))
                } else if (unifiedChunk.type === 'content' && unifiedChunk.delta) {
                  writeCompletion(serializer!.serializeStreamChunk(unifiedChunk))
                }
                // thinking / tool_call chunks have no representation in legacy completions
              }
            },
            onDoneMarker: () => {
              if (!doneSent) {
                doneSent = true
                writeCompletion(serializer!.serializeStreamChunk({ type: 'done' }))
              }
            },
            onChunkError: (e) => {
              console.error('[LLMHub] claude/complete: failed to process stream chunk, dropping it:', e)
            }
          })

          if (!doneSent) {
            doneSent = true
            writeCompletion(serializer!.serializeStreamChunk({ type: 'done' }))
          }
        } catch (streamError: any) {
          await pipeline.error(streamError)
          const resp = formatErrorResponse(streamError)
          event.node.res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: resp.error })}\n\n`)
        } finally {
          clearInterval(keepAliveTimer)
          event.node.res.end()
        }

        return
      }

      const response = await pipeline.call(request)

      const serializer = manager.getSerializer('claude-completion')
      if (!serializer) {
        throw manager.buildGatewayError('Serializer not found', 500)
      }

      const u = response.usage
      pipeline.accountingComplete({ kind: 'usage', usage: u || 0, model: request.model })
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
