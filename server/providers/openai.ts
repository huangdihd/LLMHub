import type { ProviderAdapter, ProviderConfig, LLMRequest, LLMResponse, LLMStreamChunk, ModelInfo, ContentBlock } from '../core/types'
import { fetchWithRetry } from '../utils/fetch'

export class OpenAIAdapter implements ProviderAdapter {
  name = 'openai'

  constructor(private config: ProviderConfig) {}

  toProviderRequest(request: LLMRequest): any {
    const messages: any[] = []

    if (request.config.systemPrompt) {
      messages.push({ role: 'system', content: request.config.systemPrompt })
    }

    for (const msg of request.messages) {
      if (msg.role === 'tool') {
        // Tool messages: use meta.toolCallId (from opencode) or content tool_result blocks
        const toolCallId = msg.meta?.toolCallId
        if (Array.isArray(msg.content)) {
          const toolResults = msg.content.filter(b => b.type === 'tool_result')
          if (toolResults.length > 0) {
            for (const tr of toolResults) {
              messages.push({
                role: 'tool',
                tool_call_id: tr.toolResult?.toolUseId || toolCallId,
                content: tr.toolResult?.content || ''
              })
            }
            continue
          }
        }
        // meta.toolCallId set but no tool_result blocks — send text content as tool response
        if (toolCallId) {
          const textContent = typeof msg.content === 'string'
            ? msg.content
            : (Array.isArray(msg.content) ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('') : '')
          messages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: textContent
          })
          continue
        }
        // No toolCallId at all — skip (invalid tool message)
        continue
      }

      if (Array.isArray(msg.content) && msg.content.some(b => b.type === 'tool_result')) {
        const toolResults = msg.content.filter(b => b.type === 'tool_result')
        const otherContent = msg.content.filter(b => b.type !== 'tool_result')

        // IMPORTANT: tool messages must follow assistant[tool_calls] immediately.
        // If a message has both results and text, output results FIRST.
        for (const tr of toolResults) {
          messages.push({
            role: 'tool',
            tool_call_id: tr.toolResult?.toolUseId,
            content: tr.toolResult?.content || ''
          })
        }

        if (otherContent.length > 0) {
          messages.push({
            role: msg.role,
            content: this.convertContent(otherContent)
          })
        }
      } else {
        const message: any = {
          role: msg.role
        }

        let toolUseBlocks: any[] = []

        if (typeof msg.content === 'string') {
          message.content = msg.content
        } else {
          const thinkingBlock = msg.content.find(b => b.type === 'thinking')
          if (thinkingBlock) {
            message.reasoning_content = thinkingBlock.thinking
          }

          toolUseBlocks = msg.content.filter(b => b.type === 'tool_use')
          const otherBlocks = msg.content.filter(b => b.type !== 'thinking' && b.type !== 'tool_use')

          const converted = this.convertContent(otherBlocks)
          message.content = converted && converted.length > 0 ? converted : null
        }

        const allToolCalls = [
          ...(msg.meta?.toolCalls || []),
          ...toolUseBlocks.map((b: any) => ({
            id: b.toolUse.id,
            name: b.toolUse.name,
            input: b.toolUse.input
          }))
        ]

        const seen = new Set<string>()
        const uniqueToolCalls = allToolCalls.filter(tc => {
          if (seen.has(tc.id)) return false
          seen.add(tc.id)
          return true
        })

        if (uniqueToolCalls.length > 0) {
          message.tool_calls = uniqueToolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)
            }
          }))
          if (!message.content) message.content = null
        }

        messages.push(message)
      }
    }

    const slashIndex = request.model?.indexOf('/')
    const modelId = slashIndex !== undefined && slashIndex !== -1 ? request.model!.slice(slashIndex + 1) : request.model

    const thinkingBudget = request.config.thinkingConfig?.thinkingBudget || 0
    const maxTokens = request.config.maxTokens + thinkingBudget

    const payload: any = {
      model: modelId || this.config.models[0]?.id,
      messages,
      max_tokens: maxTokens,
      temperature: request.config.temperature,
      top_p: request.config.topP,
      stop: request.config.stop,
      stream: request.stream
    }

    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }
      }))
      payload.tool_choice = this.convertToolChoice(request.toolChoice) || 'auto'
    }

    return payload
  }

  private convertContent(content: string | any[]): any {
    if (typeof content === 'string') return content

    return content.map(block => {
      if (block.type === 'text') return { type: 'text', text: block.text }
      if (block.type === 'image') {
        if (block.imageUrl) return { type: 'image_url', image_url: { url: block.imageUrl } }
        if (block.imageBase64) {
          return { type: 'image_url', image_url: { url: `data:${block.imageMediaType};base64,${block.imageBase64}` } }
        }
      }
      if (block.type === 'tool_result') {
        return { role: 'tool', tool_call_id: block.toolResult.toolUseId, content: block.toolResult.content }
      }
      if (block.type === 'tool_use') {
        // tool_use 块应在 toProviderRequest 中处理，这里作为安全兜底
        return null
      }
      return { type: 'text', text: '' }
    }).filter(Boolean)
  }

  private convertToolChoice(toolChoice: any): any {
    if (!toolChoice) return undefined
    if (typeof toolChoice === 'string') return toolChoice
    if (toolChoice.name) return { type: 'function', function: { name: toolChoice.name } }
    return 'auto'
  }

  async call(request: any): Promise<any> {
    const url = `${this.config.connection.base_url}/chat/completions`
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.connection.api_key}`,
        'Connection': 'close'
      },
      body: JSON.stringify(request)
    }, this.config.connection)

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      let errorObj: any
      try {
        errorObj = JSON.parse(errorBody)
      } catch {
        errorObj = { message: errorBody || response.statusText }
      }
      const err: any = new Error(JSON.stringify(errorObj))
      err._providerError = true
      err._statusCode = response.status
      err._errorBody = errorObj
      err._source = this.config.name
      throw err
    }

    return response.json()
  }

  callStream(request: any): ReadableStream {
    const config = this.config
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    return new ReadableStream({
      start(controller) {
        ;(async () => {
          const abortController = new AbortController()
          let timeoutId: any
          if (config.connection.enable_timeout) {
            timeoutId = setTimeout(() => abortController.abort(), config.connection.timeout || 30000)
          }

          let reader: ReadableStreamDefaultReader | undefined
          let closed = false
          const safeClose = () => {
            if (closed) return
            closed = true
            try { controller.close() } catch {}
          }
          const safeError = (err: any) => {
            if (closed) return
            closed = true
            try { controller.error(err) } catch {}
          }
          try {
            const response = await fetch(`${config.connection.base_url}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.connection.api_key}`,
                'Connection': 'close'
              },
              body: JSON.stringify(request),
              signal: abortController.signal
            })

            if (timeoutId) clearTimeout(timeoutId)

            if (!response.ok) {
              const errorBody = await response.text().catch(() => '')
              let errorObj: any
              try {
                errorObj = JSON.parse(errorBody)
              } catch {
                errorObj = { message: errorBody || response.statusText }
              }
              const err: any = new Error(JSON.stringify(errorObj))
              err._providerError = true
              err._statusCode = response.status
              err._errorBody = errorObj
              err._source = config.name
              throw err
            }

            reader = response.body?.getReader()
            if (!reader) throw new Error('No response body')

            const READ_TIMEOUT_MS = config.connection.enable_timeout ? (config.connection.timeout || 30000) / 2 : 0
            const readWithTimeout = async (r: ReadableStreamDefaultReader): Promise<ReadableStreamReadResult<any>> => {
              let idleTimeoutId: any
              const timeoutPromise = new Promise<never>((_, rej) => {
                if (READ_TIMEOUT_MS > 0) {
                  idleTimeoutId = setTimeout(() => rej(new Error(`Upstream stream read timeout (${READ_TIMEOUT_MS}ms)`)), READ_TIMEOUT_MS)
                }
              })
              try {
                if (READ_TIMEOUT_MS > 0) {
                  return await Promise.race([r.read(), timeoutPromise])
                } else {
                  return await r.read()
                }
              } finally {
                if (idleTimeoutId) clearTimeout(idleTimeoutId)
              }
            }

            let buffer = ''
            let chunkCount = 0
            let lastReadTime = Date.now()
            let streamEnded = false

            while (!streamEnded) {
              const readStart = Date.now()
              const { done, value } = await readWithTimeout(reader)
              const readMs = Date.now() - readStart
              if (done) break

              chunkCount++
              lastReadTime = Date.now()

              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split('\n')
              buffer = lines.pop() || ''

              for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed || !trimmed.startsWith('data: ')) continue
                
                const data = trimmed.slice(6).trim()
                if (data === '[DONE]') {
                  controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                  streamEnded = true
                  break
                }
                
                try {
                  controller.enqueue(encoder.encode(`data: ${data}\n\n`))
                } catch (e) {}
              }
            }

            if (!streamEnded && buffer.trim().startsWith('data: ')) {
              const trimmed = buffer.trim()
              const data = trimmed.slice(6).trim()
              if (data === '[DONE]') {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              } else {
                controller.enqueue(encoder.encode(`data: ${data}\n\n`))
              }
            }
            
          } catch (err: any) {
            safeError(err)
          } finally {
            if (timeoutId) clearTimeout(timeoutId)
            if (reader) {
              reader.cancel().catch(() => {})
            }
            safeClose()
          }
        })()
      }
    })
  }

  fromProviderResponse(response: any): LLMResponse {
    const choice = response.choices?.[0]
    if (!choice) {
      return {
        content: '',
        finishReason: 'error',
        usage: { promptTokens: 0, completionTokens: 0 }
      }
    }

    const message = choice.message
      const toolCalls = message.tool_calls?.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        input: safeJsonParseChat(tc.function.arguments || '{}')
      }))

    const content: ContentBlock[] = []
    if (message.reasoning_content) {
      content.push({ type: 'thinking', thinking: message.reasoning_content })
    }
    if (message.content) {
      content.push({ type: 'text', text: message.content })
    }

    return {
      content: content.length > 0 ? content : (message.content || ''),
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
      toolCalls,
      usage: {
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: response.usage?.completion_tokens || 0
      }
    }
  }

  fromProviderStreamChunk(chunk: any, state: any = {}): LLMStreamChunk | LLMStreamChunk[] {
    const choice = chunk.choices?.[0]
    const usage = chunk.usage ? {
      promptTokens: chunk.usage.prompt_tokens || 0,
      completionTokens: chunk.usage.completion_tokens || 0
    } : undefined

    if (!choice) {
      if (usage) {
        return { type: 'done', usage }
      }
      return { type: 'content', delta: '' }
    }

    if (choice.finish_reason) {
      const chunks: LLMStreamChunk[] = []
      if (state.dsml_buffer && state.dsml_buffer.length > 0) {
        if (!state.dsml_in_tool_calls) {
          chunks.push({ type: 'content', delta: state.dsml_buffer })
        } else {
          // If we were in tool calls but it finished, emit remaining buffer as inputDelta if we were in a parameter
          if (state.dsml_in_parameter && state.dsml_tool_index !== undefined) {
            chunks.push({
              type: 'tool_call',
              toolCall: {
                index: state.dsml_tool_index,
                inputDelta: state.dsml_buffer
              }
            })
          }
        }
        state.dsml_buffer = ''
      }

      let finishReason = choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop'
      if (state.dsml_in_tool_calls) {
         finishReason = 'tool_calls'
      }
      
      chunks.push({
        type: 'done',
        finishReason,
        usage
      })
      return chunks
    }

    if (choice.delta?.content != null && choice.delta.content !== '') {
      const content = choice.delta.content

      // DSML parser state machine
      if (!state.dsml_buffer) state.dsml_buffer = ''
      state.dsml_buffer += content
      
      const TOOL_CALLS_START_REGEX = /<[|｜]DSML[|｜]tool_calls>/
      const TOOL_CALLS_END_REGEX = /<\/[|｜]DSML[|｜]tool_calls>/
      const INVOKE_START_REGEX = /<[|｜]DSML[|｜]invoke name="([^"]+)">/
      const INVOKE_END_REGEX = /<\/[|｜]DSML[|｜]invoke>/
      
      if (!state.dsml_in_tool_calls) {
        const startMatch = state.dsml_buffer.match(TOOL_CALLS_START_REGEX)
        if (startMatch) {
          state.dsml_in_tool_calls = true
          state.dsml_tool_index = state.dsml_tool_index === undefined ? 0 : state.dsml_tool_index + 1
          
          const textBefore = state.dsml_buffer.slice(0, startMatch.index)
          state.dsml_buffer = state.dsml_buffer.slice(startMatch.index! + startMatch[0].length)
          
          // Yield whatever text came before the tool call
          return { type: 'content', delta: textBefore }
        }
      }

      if (state.dsml_in_tool_calls) {
        const chunks: LLMStreamChunk[] = []
        
        while (state.dsml_buffer.length > 0) {
          // 1. Check for end of container
          const endMatch = state.dsml_buffer.match(TOOL_CALLS_END_REGEX)
          if (endMatch && !state.dsml_current_tool_name && !state.dsml_in_parameter) {
             state.dsml_in_tool_calls = false
             state.dsml_buffer = state.dsml_buffer.slice(endMatch.index! + endMatch[0].length)
             continue
          }

          if (!state.dsml_current_tool_name) {
            // 2. Look for next tool invocation
            const match = state.dsml_buffer.match(INVOKE_START_REGEX)
            if (match) {
              state.dsml_current_tool_name = match[1]
              state.dsml_buffer = state.dsml_buffer.slice(match.index! + match[0].length)
              state.dsml_tool_id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
              chunks.push({
                type: 'tool_call',
                toolCall: {
                  index: state.dsml_tool_index,
                  id: state.dsml_tool_id,
                  name: state.dsml_current_tool_name,
                  inputDelta: ''
                }
              })
              continue
            }
          } else {
            // 3. Inside an invocation, look for parameter or end of invocation
            const paramStartRegex = /<[|｜]DSML[|｜]parameter name="([^"]+)"[^>]*>/
            const paramEndRegex = /<\/[|｜]DSML[|｜]parameter>/
            
            if (!state.dsml_in_parameter) {
              const pMatch = state.dsml_buffer.match(paramStartRegex)
              const invokeEndMatch = state.dsml_buffer.match(INVOKE_END_REGEX)
              
              if (invokeEndMatch && (!pMatch || invokeEndMatch.index! < pMatch.index!)) {
                state.dsml_current_tool_name = undefined
                state.dsml_tool_index++
                state.dsml_buffer = state.dsml_buffer.slice(invokeEndMatch.index! + invokeEndMatch[0].length)
                continue
              }
              
              if (pMatch) {
                state.dsml_in_parameter = true
                state.dsml_buffer = state.dsml_buffer.slice(pMatch.index! + pMatch[0].length)
                continue
              }
            } else {
              // 4. Inside a parameter, stream its content until paramEnd
              const pEndMatch = state.dsml_buffer.match(paramEndRegex)
              if (pEndMatch) {
                const paramContent = state.dsml_buffer.slice(0, pEndMatch.index)
                chunks.push({
                  type: 'tool_call',
                  toolCall: {
                    index: state.dsml_tool_index,
                    inputDelta: paramContent
                  }
                })
                state.dsml_in_parameter = false
                state.dsml_buffer = state.dsml_buffer.slice(pEndMatch.index! + pEndMatch[0].length)
                continue
              } else {
                // Not reached end of parameter, flush everything safely
                let safeLen = state.dsml_buffer.length
                const lastBracket = state.dsml_buffer.lastIndexOf('<')
                if (lastBracket !== -1 && lastBracket >= state.dsml_buffer.length - 10) {
                  safeLen = lastBracket
                }
                
                if (safeLen > 0) {
                  const paramContent = state.dsml_buffer.slice(0, safeLen)
                  chunks.push({
                    type: 'tool_call',
                    toolCall: {
                      index: state.dsml_tool_index,
                      inputDelta: paramContent
                    }
                  })
                  state.dsml_buffer = state.dsml_buffer.slice(safeLen)
                }
                break // Wait for more data
              }
            }
          }
          
          // If we reach here and haven't consumed anything, but there's an end tag or start tag coming,
          // we might just have whitespace/unexpected text to skip.
          // But it's safer to break and wait for more data unless we are sure we can skip.
          break
        }
        
        return chunks.length > 0 ? chunks : { type: 'content', delta: '' }
      }

      // If we are not in tool calls, flush buffer safely (keeping partial tags in buffer just in case)
      let safeEmitLen = state.dsml_buffer.length
      const lastBracket = state.dsml_buffer.lastIndexOf('<')
      if (lastBracket !== -1 && lastBracket >= state.dsml_buffer.length - 25) {
          safeEmitLen = lastBracket
      }
      
      if (safeEmitLen > 0) {
          const emitText = state.dsml_buffer.slice(0, safeEmitLen)
          state.dsml_buffer = state.dsml_buffer.slice(safeEmitLen)
          return { type: 'content', delta: emitText }
      } else {
          return { type: 'content', delta: '' }
      }
    }

    if (choice.delta?.reasoning_content) {
      return { type: 'thinking', delta: choice.delta.reasoning_content }
    }

    if (choice.delta?.reasoning) {
      return { type: 'thinking', delta: choice.delta.reasoning }
    }

    if (choice.delta?.tool_calls) {
      if (choice.delta.tool_calls.length > 1) {
        return choice.delta.tool_calls.map((tc: any) => ({
          type: 'tool_call',
          toolCall: {
            index: tc.index,
            id: tc.id,
            name: tc.function?.name,
            inputDelta: tc.function?.arguments
          }
        }))
      }

      const tc = choice.delta.tool_calls[0]
      if (tc) {
        return {
          type: 'tool_call',
          toolCall: {
            index: tc.index,
            id: tc.id,
            name: tc.function?.name,
            inputDelta: tc.function?.arguments
          }
        }
      }
    }

    // Do not return 'done' just because usage is present; some providers send it in every chunk.
    // We only return 'done' if finish_reason is set or when [DONE] is received.
    return { type: 'content', delta: '' }
  }

  getModels(): ModelInfo[] {
    return this.config.models.map(m => ({
      id: `${this.config.name}/${m.id}`,
      provider: this.config.name,
      name: m.id,
      display_name: m.display_name,
      capabilities: m.capabilities
    }))
  }
}

function safeJsonParseChat(str: string): object {
  try {
    return JSON.parse(str)
  } catch {
    return {}
  }
}
