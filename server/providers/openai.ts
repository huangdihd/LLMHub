import type { ProviderAdapter, ProviderConfig, LLMRequest, LLMResponse, LLMStreamChunk, ModelInfo } from '../core/types'

export class OpenAIAdapter implements ProviderAdapter {
  name = 'openai'

  constructor(private config: ProviderConfig) {}

  toProviderRequest(request: LLMRequest): any {
    const messages: any[] = []

    if (request.config.systemPrompt) {
      messages.push({ role: 'system', content: request.config.systemPrompt })
    }

    for (const msg of request.messages) {
      if (Array.isArray(msg.content) && msg.content.some(b => b.type === 'tool_result')) {
        const toolResults = msg.content.filter(b => b.type === 'tool_result')
        const otherContent = msg.content.filter(b => b.type !== 'tool_result')

        if (otherContent.length > 0) {
          messages.push({
            role: msg.role,
            content: this.convertContent(otherContent)
          })
        }

        for (const tr of toolResults) {
          messages.push({
            role: 'tool',
            tool_call_id: tr.toolResult?.toolUseId,
            content: tr.toolResult?.content || ''
          })
        }
      } else {
        const message: any = {
          role: msg.role
        }

        if (typeof msg.content === 'string') {
          message.content = msg.content
        } else {
          const thinkingBlock = msg.content.find(b => b.type === 'thinking')
          if (thinkingBlock) {
            message.reasoning_content = thinkingBlock.thinking
          }

          // 提取 tool_use 块，后续转为 tool_calls
          const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use')
          const otherBlocks = msg.content.filter(b => b.type !== 'thinking' && b.type !== 'tool_use')

          const converted = this.convertContent(otherBlocks)
          message.content = converted && converted.length > 0 ? converted : null

          // 合并来自 meta.toolCalls 和 content 中 tool_use 块的工具调用，去重
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
        }

        messages.push(message)
      }
    }

    const slashIndex = request.model?.indexOf('/')
    const modelId = slashIndex !== undefined && slashIndex !== -1 ? request.model!.slice(slashIndex + 1) : request.model

    // OpenAI API: max_tokens includes thinking tokens (unlike Claude where thinking is separate)
    // Use a much larger budget to ensure room for both thinking and content/tool_calls
    const maxTokens = request.config.maxTokens > 0
      ? Math.max(request.config.maxTokens, 16000)
      : 16000

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
    const response = await fetch(`${this.config.connection.base_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.connection.api_key}`,
        'Connection': 'close'
      },
      body: JSON.stringify(request)
    })

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
          const fetchTimeout = setTimeout(() => {
            abortController.abort()
          }, 30000) // 30s connection timeout

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

            clearTimeout(fetchTimeout)

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

            const READ_TIMEOUT_MS = 15000
            const readWithTimeout = async (r: ReadableStreamDefaultReader): Promise<ReadableStreamReadResult<any>> => {
              let timeoutId: any
              const timeoutPromise = new Promise<never>((_, rej) => {
                timeoutId = setTimeout(() => rej(new Error('Upstream stream read timeout (15s)')), READ_TIMEOUT_MS)
              })
              try {
                return await Promise.race([r.read(), timeoutPromise])
              } finally {
                clearTimeout(timeoutId)
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
            
          } catch (err) {
            safeError(err)
          } finally {
            clearTimeout(fetchTimeout)
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
      input: JSON.parse(tc.function.arguments || '{}')
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

  fromProviderStreamChunk(chunk: any): LLMStreamChunk {
    const choice = chunk.choices?.[0]
    const usage = chunk.usage ? {
      promptTokens: chunk.usage.prompt_tokens || 0,
      completionTokens: chunk.usage.completion_tokens || 0
    } : undefined

    if (!choice) {
      if (usage) {
        console.log('DEBUG: returning done because no choice but usage present');
        return { type: 'done', usage }
      }
      return { type: 'content', delta: '' }
    }

    if (choice.finish_reason) {
      console.log('DEBUG: returning done because choice.finish_reason is present:', choice.finish_reason);
      return {
        type: 'done',
        finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
        usage
      }
    }

    if (choice.delta?.content != null && choice.delta.content !== '') {
      return { type: 'content', delta: choice.delta.content }
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
