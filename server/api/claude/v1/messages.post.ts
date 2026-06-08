import { ProviderManager } from '../../../providers/manager'
import { getProviderStore } from '../../../stores/provider.store'

const CCH_REGEX = /;\s*cch=\w+;/g

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const manager = new ProviderManager()
  await manager.loadProviders()

  const parser = manager.getParser('/v1/messages', 'POST', body)
  if (!parser) {
    throw createError({ statusCode: 400, message: 'Invalid request' })
  }

  let request
  let keepAliveTimer: any = null
  try {
    request = parser.parseRequest(body)
  } catch (parseError: any) {
    throw createError({ statusCode: 400, message: `Parse error: ${parseError.message}` })
  }

  try {
    await incrementCalls()
    const resolved = manager.resolveAdapter(request.model || '', 'claude-messages', request.stream)
    const adapter = resolved?.adapter

    if (!adapter) {
      throw new Error(`Adapter not found for model: ${request.model}`)
    }

    console.log(`[LLMHub] ${new Date().toISOString()} key=${event.context._apiKeyRecord?.name || 'unknown'} model=${request.model} provider=${resolved.providerName}(${adapter.name}) stream=${request.stream ?? false}`)

    // Apply CCH normalization before adapter formats the request
    if (resolved.providerName && request.config.systemPrompt) {
      const providerConfig = await getProviderStore().get(resolved.providerName)
      if (providerConfig?.normalize_cch) {
        request.config.systemPrompt = request.config.systemPrompt.replace(CCH_REGEX, '; cch=00000;')
      }
    }

    if (request.stream && adapter) {
      const providerRequest = adapter.toProviderRequest({ ...request, stream: true })

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

        const stream = adapter.callStream(providerRequest)
        const reader = stream.getReader()
        const decoder = new TextDecoder()

        let blockStarted = false
        let blockIndex = 0
        let isWritingTool = false
        let isWritingThinking = false
        let streamDone = false
        let thinkingBuffer: string[] = []
        let thinkingFlushed = false
        let pendingToolUseName: string | null = null

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
          writeSSE('content_block_stop', { type: "content_block_stop", index: blockIndex })
          blockIndex++
          blockStarted = false
          isWritingThinking = false
          thinkingFlushed = true
          thinkingBuffer = []
        }

        const handleChunk = (unifiedChunk: any) => {
          if (!serializer) return

          if (unifiedChunk.type === 'thinking') {
            if (!unifiedChunk.delta) return
            thinkingBuffer.push(unifiedChunk.delta)
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
                                        } else if (unifiedChunk.type === 'tool_call') {
            flushThinkingBuffer()

            const toolCall = unifiedChunk.toolCall
            if (toolCall?.name && !toolCall?.id) {
              pendingToolUseName = toolCall.name
              return
            }

            const serializedChunk = serializer.serializeStreamChunk(unifiedChunk)

            if (serializedChunk.type === 'content_block_start') {
              if (blockStarted) {
                writeSSE('content_block_stop', { type: "content_block_stop", index: blockIndex })
                blockIndex++
              }
              serializedChunk.index = blockIndex
              writeSSE('content_block_start', serializedChunk)
              blockStarted = true
              isWritingTool = true
              pendingToolUseName = null

              // Gemini may return full args in the same chunk; emit delta immediately
              if (toolCall?.inputDelta) {
                const deltaChunk = serializer.serializeStreamChunk({
                  type: 'tool_call',
                  toolCall: { inputDelta: toolCall.inputDelta }
                })
                deltaChunk.index = blockIndex
                writeSSE('content_block_delta', deltaChunk)
              }
            } else {
              // Handle pending tool_use (name arrived before id)
              if (pendingToolUseName && !isWritingTool) {
                if (blockStarted) {
                  writeSSE('content_block_stop', { type: "content_block_stop", index: blockIndex })
                  blockIndex++
                }
                writeSSE('content_block_start', {
                  type: "content_block_start",
                  index: blockIndex,
                  content_block: { type: "tool_use", id: toolCall?.id || '', name: pendingToolUseName }
                })
                blockStarted = true
                isWritingTool = true
                pendingToolUseName = null
              }
              serializedChunk.index = blockIndex
              writeSSE('content_block_delta', serializedChunk)
            }
                              } else if (unifiedChunk.type === 'done') {
            if (streamDone) {
              // Some providers split usage into a separate chunk — capture if available
              const u = (unifiedChunk as any).usage
              if (u) trackUsage(event, (u.promptTokens || 0) + (u.completionTokens || 0), request.model)
              return
            }
            streamDone = true

            // Track token usage from the final chunk
            const u = (unifiedChunk as any).usage
            if (u) trackUsage(event, (u.promptTokens || 0) + (u.completionTokens || 0), request.model)

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

        let rawIdx = 0
        let lineBuffer = ''
        let providerState = {}

        const processLine = (line: string) => {
          if (!line.startsWith('data: ')) return
          const data = line.slice(6).trim()
          if (data === '[DONE]') {
            handleChunk({ type: 'done' })
            return
          }
          if (!data) return
          rawIdx++
          try {
            const originalChunk = JSON.parse(data)
            const unifiedChunksRaw = adapter!.fromProviderStreamChunk(originalChunk, providerState)
            const unifiedChunks = Array.isArray(unifiedChunksRaw) ? unifiedChunksRaw : [unifiedChunksRaw]

                        for (const unifiedChunk of unifiedChunks) {
              handleChunk(unifiedChunk)
            }
          } catch(e) {}
        }

        const processRawChunk = (chunkStr: string) => {
          lineBuffer += chunkStr
          const lines = lineBuffer.split('\n')
          lineBuffer = lines.pop() || ''
          for (const line of lines) {
            processLine(line)
          }
        }

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          processRawChunk(decoder.decode(value, { stream: true }))
        }
        if (lineBuffer.trim()) processLine(lineBuffer.trim())

        // 6. message_stop
        writeSSE('message_stop', { type: "message_stop" })

      } catch (streamError: any) {
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

    const response = await manager.callLLM(request)
    const serializer = manager.getSerializer('claude-messages')
    if (!serializer) {
      throw new Error('Serializer not found')
    }
    const u = response.usage
    trackUsage(event, (u?.promptTokens || 0) + (u?.completionTokens || 0), request.model)
    return serializer.serializeResponse(response)
  } catch (error: any) {
    throw createError({ statusCode: 400, message: error.message })
  }
})
