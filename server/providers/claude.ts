import type {
  ProviderAdapter,
  ProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  ModelInfo,
  ContentBlock
} from '../core/types'
import { fetchWithRetry } from '../utils/fetch'

const CCH_REGEX = /\bcch=[^;\s]+/g

export class ClaudeAdapter implements ProviderAdapter {
  name = 'claude'

  constructor(private config: ProviderConfig) {}

  toProviderRequest(request: LLMRequest): any {
    const messages: any[] = []

    for (const msg of request.messages) {
      if (msg.role === 'system') continue

      let role = msg.role === 'tool' ? 'user' : msg.role
      let contentBlocks: any[] = []

      const converted = this.convertContent(msg.content)
      if (typeof converted === 'string') {
        if (converted) {
          contentBlocks.push({ type: 'text', text: converted })
        }
      } else if (Array.isArray(converted)) {
        contentBlocks = [...converted]
      }

      if (msg.role === 'assistant') {
        if (msg.meta?.toolCalls?.length) {
          for (const tc of msg.meta.toolCalls) {
            if (!contentBlocks.some(b => b.type === 'tool_use' && b.id === tc.id)) {
              contentBlocks.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.name,
                input: typeof tc.input === 'string' ? safeJsonParse(tc.input || '{}') : tc.input
              })
            }
          }
        }
      } else if (msg.role === 'tool') {
        if (msg.meta?.toolCallId && !contentBlocks.some(b => b.type === 'tool_result')) {
          const textContent = contentBlocks
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n')

          contentBlocks = [{
            type: 'tool_result',
            tool_use_id: msg.meta.toolCallId,
            content: textContent || (typeof msg.content === 'string' ? msg.content : '')
          }]
        }
      }

      if (messages.length > 0 && messages[messages.length - 1].role === role) {
        const prevMsg = messages[messages.length - 1]
        let prevBlocks = typeof prevMsg.content === 'string' 
          ? (prevMsg.content ? [{ type: 'text', text: prevMsg.content }] : [])
          : [...prevMsg.content]
        
        prevMsg.content = prevBlocks.concat(contentBlocks)
      } else {
        messages.push({ role, content: contentBlocks.length > 0 ? contentBlocks : '' })
      }
    }

    const slashIndex = request.model?.indexOf('/')
    const modelId = slashIndex !== undefined && slashIndex !== -1 ? request.model!.slice(slashIndex + 1) : request.model

    return {
      model: modelId || this.config.models[0]?.id,
      max_tokens: request.config.maxTokens,
      system: (this.config.normalize_cch && request.config.systemPrompt)
        ? request.config.systemPrompt.replace(CCH_REGEX, 'cch=00000')
        : request.config.systemPrompt,
      messages,
      temperature: request.config.temperature,
      top_p: request.config.topP,
      stop_sequences: request.config.stop,
      tools: request.tools?.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters
      })),
      tool_choice: this.convertToolChoice(request.toolChoice),
      stream: request.stream
    }
  }

  private convertContent(content: string | any[]): any {
    if (typeof content === 'string') return content

    return content.map(block => {
      if (block.type === 'text') return { type: 'text', text: block.text }
      if (block.type === 'image') {
        if (block.imageBase64) {
          return { type: 'image', source: { type: 'base64', media_type: block.imageMediaType || 'image/jpeg', data: block.imageBase64 } }
        }
        if (block.imageUrl) {
          if (block.imageUrl.startsWith('data:')) {
            const match = block.imageUrl.match(/^data:([^;]+);base64,(.+)$/)
            if (match) {
              return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
            }
          }
          return { type: 'image', source: { type: 'url', url: block.imageUrl } }
        }
      }
      if (block.type === 'tool_use') {
        return { type: 'tool_use', id: block.toolUse.id, name: block.toolUse.name, input: block.toolUse.input }
      }
      if (block.type === 'tool_result') {
        return {
          type: 'tool_result',
          tool_use_id: block.toolResult.toolUseId,
          content: block.toolResult.content,
          is_error: block.toolResult.isError
        }
      }
      if (block.type === 'thinking') {
        return {
          type: 'thinking',
          thinking: block.thinking
        }
      }
      if (block.type === 'redacted_thinking') {
        return {
          type: 'redacted_thinking',
          signature: block.signature
        }
      }
      return { type: 'text', text: '' }
    })
  }

  private convertToolChoice(toolChoice: any): any {
    if (!toolChoice) return undefined
    if (toolChoice === 'auto') return { type: 'auto' }
    if (toolChoice === 'required') return { type: 'any' }
    if (toolChoice.name) return { type: 'tool', name: toolChoice.name }
    return undefined
  }

  async call(request: any): Promise<any> {
    const headers: any = {
      'Content-Type': 'application/json',
      'x-api-key': this.config.connection.api_key,
      'anthropic-version': this.config.connection.version || '2023-06-01'
    }

    const response = await fetchWithRetry(`${this.config.connection.base_url}/v1/messages`, {
      method: 'POST',
      headers,
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
            const headers: any = {
              'Content-Type': 'application/json',
              'x-api-key': config.connection.api_key,
              'anthropic-version': config.connection.version || '2023-06-01'
            }

            const response = await fetch(`${config.connection.base_url}/v1/messages`, {
              method: 'POST',
              headers,
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
            while (true) {
              const { done, value } = await readWithTimeout(reader)
              if (done) break

              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split('\n')
              buffer = lines.pop() || ''

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const data = line.slice(6).trim()
                  if (!data) continue
                  try {
                    const chunk = JSON.parse(data)
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                  } catch (e) {}
                }
              }
            }

            if (buffer.startsWith('data: ')) {
              const data = buffer.slice(6).trim()
              if (data) {
                try {
                  const chunk = JSON.parse(data)
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                } catch (e) {}
              }
            }
          } catch (err) {
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
    const content: ContentBlock[] = []
    const toolCalls: any[] = []

    for (const block of response.content || []) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text })
      } else if (block.type === 'thinking') {
        content.push({ type: 'thinking', thinking: block.thinking })
      } else if (block.type === 'redacted_thinking') {
        content.push({ type: 'redacted_thinking', signature: block.signature })
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input
        })
      }
    }

    return {
      content,
      finishReason: response.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: response.usage?.input_tokens || 0,
        completionTokens: response.usage?.output_tokens || 0
      }
    } as LLMResponse
  }

  fromProviderStreamChunk(chunk: any, state: any = {}): LLMStreamChunk {
    // message_start carries input_tokens — stash for later
    if (chunk.type === 'message_start') {
      if (chunk.message?.usage?.input_tokens) {
        state._inputTokens = chunk.message.usage.input_tokens
      }
      return { type: 'content', delta: '' }
    }

    if (chunk.type === 'message_stop') {
      const usage = state._inputTokens
        ? { promptTokens: state._inputTokens, completionTokens: 0 }
        : undefined
      delete state._inputTokens
      return { type: 'done', usage }
    }

    if (chunk.type === 'content_block_delta') {
      if (chunk.delta?.type === 'text_delta') {
        return { type: 'content', delta: chunk.delta.text }
      }
      if (chunk.delta?.type === 'thinking_delta') {
        return { type: 'thinking', delta: chunk.delta.thinking }
      }
      if (chunk.delta?.type === 'signature_delta') {
        return { type: 'content', delta: '' }
      }
      if (chunk.delta?.type === 'input_json_delta') {
        return {
          type: 'tool_call',
          toolCall: { index: chunk.index, inputDelta: chunk.delta.partial_json }
        }
      }
    }

    if (chunk.type === 'content_block_start') {
      if (chunk.content_block?.type === 'tool_use') {
        return {
          type: 'tool_call',
          toolCall: {
            index: chunk.index,
            id: chunk.content_block.id,
            name: chunk.content_block.name
          }
        }
      }
    }

    if (chunk.type === 'message_delta') {
      // Accumulate output_tokens (sometimes on delta, sometimes on usage)
      if (chunk.usage?.output_tokens) {
        state._outputTokens = (state._outputTokens || 0) + chunk.usage.output_tokens
      }

      if (chunk.delta?.stop_reason) {
        const promptTokens = state._inputTokens || 0
        const completionTokens = state._outputTokens || chunk.usage?.output_tokens || 0
        delete state._inputTokens
        delete state._outputTokens
        return {
          type: 'done',
          finishReason: chunk.delta.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
          usage: { promptTokens, completionTokens }
        }
      }
      // message_delta without stop_reason: still collect output_tokens
      return { type: 'content', delta: '' }
    }

    // Default to an empty content chunk if nothing matched, 
    // but handleChunk should ideally skip if delta is empty.
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

function safeJsonParse(str: string): object {
  try {
    return JSON.parse(str)
  } catch {
    return {}
  }
}
