import { ProviderManager } from '../../../providers/manager'
import { RequestPipeline } from '../../../core/pipeline'
import type { LLMRequest } from '../../../core/types'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const manager = new ProviderManager()
  await manager.loadProviders()

  const pipeline = new RequestPipeline(manager, event, 'claude-messages')
  try {
    const parser = manager.getParser('/v1/messages', 'POST', body)
    if (!parser) {
      throw createError({ statusCode: 400, message: 'Invalid request' })
    }

    let request: LLMRequest
    let keepAliveTimer: any = null
    try {
      request = parser.parseRequest(body)
    } catch (parseError: any) {
      await pipeline.error(parseError)
      throw createError({ statusCode: 400, message: `Parse error: ${parseError.message}` })
    }

    try {
      await pipeline.accountingComplete({ kind: 'attempt' })
      const prepared = await pipeline.prepare(request)
      request = prepared.request
      const resolved = prepared.resolved
      const adapter = resolved?.adapter

      if (!adapter) {
        throw new Error(`Adapter not found for model: ${request.model}`)
      }

      console.log(`[LLMHub] ${new Date().toISOString()} key=${event.context._apiKeyRecord?.name || 'unknown'} model=${request.model} provider=${resolved.providerName}(${adapter.name}) stream=${request.stream ?? false}`)

      // Apply CCH normalization before adapter formats the request
      Object.assign(request, await pipeline.normalizeRequest(request))

      if (request.stream && adapter) {
        const stream = await pipeline.openStream(request, adapter)

        try {
          setResponseHeaders(event, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
          })
          event.node.res.flushHeaders()

          const serializer = manager.getSerializer('claude-messages')

          let sseCount = 0
          const writeSSE = (eventType: string, data: any) => {
            sseCount++
            event.node.res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`)
          }

          // 1. message_start (send immediately)
          writeSSE('message_start', {
            type: "message_start",
            message: {
              id: 'msg-' + Date.now(),
              type: "message",
              role: "assistant",
              model: request.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 }
            }
          })

          // Keep-alive ping
          keepAliveTimer = setInterval(() => {
            if (!event.node.res.writableEnded) {
              event.node.res.write(`event: ping\ndata: {"type":"ping"}\n\n`)
            }
          }, 15000)

          let blockStarted = false
          let blockIndex = 0
          let isWritingTool = false
          let isWritingThinking = false
          let streamDone = false
          let thinkingBuffer: string[] = []
          let thinkingSignatures: string[] = []
          let thinkingFlushed = false
          let currentToolIndex: number | undefined

          const flushThinkingBuffer = () => {
            if (thinkingBuffer.length === 0 || thinkingFlushed) return
            if (blockStarted) {
              writeSSE('content_block_stop', { type: "content_block_stop", index: blockIndex })
              blockIndex++
            }
            writeSSE('content_block_start', {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "thinking", thinking: "" }
            })
            for (const text of thinkingBuffer) {
              const chunk = serializer!.serializeStreamChunk({ type: 'thinking', delta: text })
              chunk.index = blockIndex
              writeSSE('content_block_delta', chunk)
            }
            for (const signature of thinkingSignatures) {
              const chunk = serializer!.serializeStreamChunk({ type: 'thinking', signature })
              chunk.index = blockIndex
              writeSSE('content_block_delta', chunk)
            }
            writeSSE('content_block_stop', { type: "content_block_stop", index: blockIndex })
            blockIndex++
            blockStarted = false
            isWritingThinking = false
            thinkingFlushed = true
            thinkingBuffer = []
            thinkingSignatures = []
          }

          const handleChunk = (unifiedChunk: any) => {
            if (!serializer) return

            if (unifiedChunk.type === 'thinking') {
              if (unifiedChunk.delta) thinkingBuffer.push(unifiedChunk.delta)
              if (unifiedChunk.signature) thinkingSignatures.push(unifiedChunk.signature)
              if (!unifiedChunk.delta && !unifiedChunk.signature) return
            } else if (unifiedChunk.type === 'content') {
              if (!unifiedChunk.delta) return
              flushThinkingBuffer()

              if (!blockStarted || isWritingTool || isWritingThinking) {
                if (blockStarted) {
                  writeSSE('content_block_stop', { type: "content_block_stop", index: blockIndex })
                  blockIndex++
                }
                writeSSE('content_block_start', {
                  type: "content_block_start",
                  index: blockIndex,
                  content_block: { type: "text", text: "" }
                })
                blockStarted = true
                isWritingTool = false
                isWritingThinking = false
              }

              const serializedChunk = serializer.serializeStreamChunk(unifiedChunk)
              serializedChunk.index = blockIndex
              writeSSE('content_block_delta', serializedChunk)
            } else if (unifiedChunk.type === 'opaque_reasoning' && unifiedChunk.reasoningProvider === 'anthropic' && unifiedChunk.opaqueData) {
              flushThinkingBuffer()
              if (blockStarted) {
                writeSSE('content_block_stop', { type: 'content_block_stop', index: blockIndex })
                blockIndex++
                blockStarted = false
              }
              writeSSE('content_block_start', {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'redacted_thinking', data: unifiedChunk.opaqueData }
              })
              writeSSE('content_block_stop', { type: 'content_block_stop', index: blockIndex })
              blockIndex++
            } else if (unifiedChunk.type === 'tool_call') {
              flushThinkingBuffer()

              const toolCall = unifiedChunk.toolCall
              if (!toolCall) return

              // Call boundary: prefer the upstream index when both sides carry
              // one (providers that repeat id/name on every delta chunk would
              // otherwise split one call into many); fall back to "id present".
              // A name without id must still open a block immediately — some
              // OpenAI-compatible providers never send ids, and buffering the
              // chunk would drop its inputDelta with it.
              let startsNewCall: boolean
              if (!isWritingTool) {
                startsNewCall = true
              } else if (toolCall.index !== undefined && currentToolIndex !== undefined) {
                startsNewCall = toolCall.index !== currentToolIndex
              } else {
                startsNewCall = !!toolCall.id
              }

              if (startsNewCall) {
                if (blockStarted) {
                  writeSSE('content_block_stop', { type: "content_block_stop", index: blockIndex })
                  blockIndex++
                }
                writeSSE('content_block_start', {
                  type: "content_block_start",
                  index: blockIndex,
                  content_block: {
                    type: "tool_use",
                    id: toolCall.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    name: toolCall.name || ''
                  }
                })
                blockStarted = true
                isWritingTool = true
                isWritingThinking = false
                currentToolIndex = toolCall.index
              }

              if (toolCall.inputDelta) {
                writeSSE('content_block_delta', {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: 'input_json_delta', partial_json: toolCall.inputDelta }
                })
              }
            } else if (unifiedChunk.type === 'done') {
              if (streamDone) {
                // Some providers split usage into a separate chunk — capture if available
                const u = (unifiedChunk as any).usage
                if (u) pipeline.accountingComplete({ kind: 'usage', usage: u, model: request.model })
                return
              }
              streamDone = true

              // Track token usage from the final chunk
              const u = (unifiedChunk as any).usage
              if (u) pipeline.accountingComplete({ kind: 'usage', usage: u, model: request.model })

              // Flush any remaining buffered thinking
              if (thinkingBuffer.length > 0 && !thinkingFlushed) {
                flushThinkingBuffer()
              }

              if (blockStarted) {
                writeSSE('content_block_stop', {
                  type: "content_block_stop",
                  index: blockIndex
                })
                blockStarted = false
              }

              const serializedChunk = serializer.serializeStreamChunk(unifiedChunk)
              writeSSE('message_delta', serializedChunk)
            }
          }

          await pipeline.consumeStream(stream, adapter, {
            onChunks: (unifiedChunks) => {
              for (const unifiedChunk of unifiedChunks) {
                handleChunk(unifiedChunk)
              }
            },
            onDoneMarker: () => {
              handleChunk({ type: 'done' })
            },
            onChunkError: (e) => {
              console.error('[LLMHub] claude/messages: failed to process stream chunk, dropping it:', e)
            }
          })

          // 6. message_stop
          writeSSE('message_stop', { type: "message_stop" })

        } catch (streamError: any) {
          await pipeline.error(streamError)
          if (!event.node.res.headersSent) {
            setResponseStatus(event, 400)
            return {
              error: { type: 'invalid_request_error', message: streamError.message }
            }
          } else {
            event.node.res.write(`event: error\ndata: ${JSON.stringify({ error: { type: 'api_error', message: streamError.message } })}\n\n`)
          }
        } finally {
          if (keepAliveTimer) clearInterval(keepAliveTimer)
          if (!event.node.res.writableEnded) {
            event.node.res.end()
          }
        }

        return
      }

      const response = await pipeline.call(request)
      const serializer = manager.getSerializer('claude-messages')
      if (!serializer) {
        throw new Error('Serializer not found')
      }
      const u = response.usage
      pipeline.accountingComplete({ kind: 'usage', usage: u || 0, model: request.model })
      return serializer.serializeResponse(response)
    } catch (error: any) {
      await pipeline.error(error)
      if (error?._providerError) throwFormattedError(error)
      throw createError({ statusCode: 400, message: error.message })
    }
  } catch (error) {
    await pipeline.error(error)
    throw error
  } finally {
    await pipeline.complete()
  }
})
