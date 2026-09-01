import type {
  Content,
  ContentBlock,
  EmbeddingRequest,
  EmbeddingResponse,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  ModelInfo,
  ProviderAdapter,
  ProviderConfig,
  ToolCall
} from '../core/types'
import { fetchWithRetry } from '../utils/fetch'
import { extractChatGptAccountId } from '../utils/codex-auth'
import { ensureCodexAccessToken } from '../services/codex-token-manager'

type CodexHeaders = Record<string, string>

/**
 * Adapter for the ChatGPT-subscription Codex Responses backend.
 *
 * The upstream is stream-only. `call()` therefore consumes its SSE response and
 * returns the terminal Responses object for non-streaming gateway clients.
 */
export class CodexAdapter implements ProviderAdapter {
  name = 'codex-subscription'

  constructor(private config: ProviderConfig) {}

  toProviderRequest(request: LLMRequest): any {
    const input: any[] = []

    for (const message of request.messages) {
      const blocks = typeof message.content === 'string'
        ? [{ type: 'text', text: message.content } as ContentBlock]
        : message.content

      const reasoningSummary = blocks
        .filter(block => block.type === 'thinking')
        .map(block => block.thinking || '')
        .join('')
      const encryptedReasoning = blocks.find(block => block.type === 'redacted_thinking')?.signature
      if (encryptedReasoning) {
        input.push({
          type: 'reasoning',
          encrypted_content: encryptedReasoning,
          summary: reasoningSummary
            ? [{ type: 'summary_text', text: reasoningSummary }]
            : []
        })
      }

      const toolResults = blocks.filter(block => block.type === 'tool_result')
      if (message.role === 'tool' && toolResults.length === 0 && message.meta?.toolCallId) {
        input.push({
          type: 'function_call_output',
          call_id: message.meta.toolCallId,
          output: this.convertToolOutput(message.content)
        })
        continue
      }

      for (const block of toolResults) {
        if (!block.toolResult?.toolUseId) continue
        input.push({
          type: 'function_call_output',
          call_id: block.toolResult.toolUseId,
          output: this.convertToolOutput(block.toolResult.content)
        })
      }

      const messageParts = blocks
        .filter(block => !['thinking', 'redacted_thinking', 'tool_use', 'tool_result'].includes(block.type))
        .filter(block => block.type !== 'text' || !!block.text)
        .map(block => this.convertContentBlock(block, message.role === 'assistant'))
        .filter(Boolean)

      if (message.role !== 'tool' && messageParts.length > 0) {
        input.push({
          type: 'message',
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: messageParts
        })
      }

      const toolCalls = [
        ...(message.meta?.toolCalls || []),
        ...blocks
          .filter(block => block.type === 'tool_use' && block.toolUse)
          .map(block => block.toolUse!)
      ]
      const seen = new Set<string>()
      for (const call of toolCalls) {
        if (!call.id || seen.has(call.id)) continue
        seen.add(call.id)
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: typeof call.input === 'string' ? call.input : JSON.stringify(call.input)
        })
      }
    }

    const model = stripProviderPrefix(request.model) || this.config.models[0]?.id
    const payload: any = {
      model,
      instructions: request.config.systemPrompt || '',
      input,
      store: false,
      // The ChatGPT Codex backend is SSE-only, including for a downstream sync call.
      stream: true,
      client_metadata: {
        'x-codex-installation-id': this.config.connection.device_id
      }
    }

    if (request.config.reasoningEffort || request.config.reasoningSummary) {
      payload.reasoning = {
        ...(request.config.reasoningEffort ? { effort: request.config.reasoningEffort } : {}),
        summary: request.config.reasoningSummary || 'auto'
      }
      payload.include = ['reasoning.encrypted_content']
    }

    if (request.tools?.length) {
      payload.tools = request.tools.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false
      }))
      payload.tool_choice = this.convertToolChoice(request.toolChoice) || 'auto'
      payload.parallel_tool_calls = true
    }

    return payload
  }

  async call(request: any): Promise<any> {
    const headers = await this.headers()
    const response = await fetchWithRetry(this.responsesUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...request, stream: true, store: false })
    }, this.config.connection)

    if (!response.ok) throw await this.providerError(response)

    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) return response.json()

    const body = await response.text()
    let terminal: any
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') continue
      let event: any
      try {
        event = JSON.parse(data)
      } catch {
        continue
      }
      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        terminal = event.response
      } else if (event.type === 'response.failed' || event.type === 'error') {
        throw this.eventError(event)
      }
    }

    if (!terminal) {
      const err: any = new Error('Codex stream ended without a terminal response')
      err._providerError = true
      err._statusCode = 502
      err._errorBody = { message: err.message }
      err._source = this.config.name
      throw err
    }
    return terminal
  }

  callStream(request: any): ReadableStream {
    const adapter = this
    const config = this.config
    const url = this.responsesUrl()
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    return new ReadableStream({
      start(controller) {
        ;(async () => {
          const abortController = new AbortController()
          let timeoutId: ReturnType<typeof setTimeout> | undefined
          if (config.connection.enable_timeout) {
            timeoutId = setTimeout(
              () => abortController.abort(),
              config.connection.timeout || 30000
            )
          }

          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
          let closed = false
          const close = () => {
            if (closed) return
            closed = true
            try { controller.close() } catch {}
          }
          const fail = (error: any) => {
            if (closed) return
            closed = true
            try { controller.error(error) } catch {}
          }

          try {
            const headers = await adapter.headers()
            const response = await fetch(url, {
              method: 'POST',
              headers,
              body: JSON.stringify({ ...request, stream: true, store: false }),
              signal: abortController.signal
            })
            if (timeoutId) clearTimeout(timeoutId)
            if (!response.ok) {
              const text = await response.text().catch(() => '')
              let errorBody: any
              try { errorBody = JSON.parse(text) } catch { errorBody = { message: text || response.statusText } }
              const error: any = new Error(JSON.stringify(errorBody))
              error._providerError = true
              error._statusCode = response.status
              error._errorBody = errorBody
              error._source = config.name
              throw error
            }

            reader = response.body?.getReader()
            if (!reader) throw new Error('Codex response has no body')
            let buffer = ''
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split(/\r?\n/)
              buffer = lines.pop() || ''
              for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed.startsWith('data:')) continue
                controller.enqueue(encoder.encode(`data: ${trimmed.slice(5).trim()}\n\n`))
              }
            }
            if (buffer.trim().startsWith('data:')) {
              controller.enqueue(encoder.encode(`data: ${buffer.trim().slice(5).trim()}\n\n`))
            }
          } catch (error) {
            fail(error)
          } finally {
            if (timeoutId) clearTimeout(timeoutId)
            if (reader) reader.cancel().catch(() => {})
            close()
          }
        })()
      }
    })
  }

  fromProviderResponse(response: any): LLMResponse {
    const content: ContentBlock[] = []
    const toolCalls: ToolCall[] = []

    for (const item of response.output || []) {
      if (item.type === 'reasoning') {
        const summary = (item.summary || []).map((part: any) => part.text || '').join('')
        if (summary) content.push({ type: 'thinking', thinking: summary })
        if (item.encrypted_content) {
          content.push({ type: 'redacted_thinking', signature: item.encrypted_content })
        }
      } else if (item.type === 'message') {
        for (const part of item.content || []) {
          if (part.type === 'output_text') content.push({ type: 'text', text: part.text || '' })
          else if (part.type === 'refusal') content.push({ type: 'text', text: part.refusal || '' })
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: item.call_id || item.id,
          name: item.name,
          input: safeJsonParse(item.arguments || '{}')
        })
      }
    }

    return {
      content: content.length > 0 ? content : '',
      finishReason: mapCodexFinishReason(response, toolCalls.length > 0),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      usage: mapUsage(response.usage)
    }
  }

  fromProviderStreamChunk(chunk: any, state: any = {}): LLMStreamChunk | LLMStreamChunk[] {
    state.calls ||= new Map<number, any>()

    if (chunk.type === 'response.output_text.delta') {
      return { type: 'content', delta: chunk.delta || '' }
    }
    if (chunk.type === 'response.reasoning_summary_text.delta') {
      return { type: 'thinking', delta: chunk.delta || '' }
    }
    if (chunk.type === 'response.output_item.done' && chunk.item?.type === 'reasoning' && chunk.item.encrypted_content) {
      return { type: 'thinking', encryptedContent: chunk.item.encrypted_content }
    }
    if (chunk.type === 'response.output_item.added' && chunk.item?.type === 'function_call') {
      const index = chunk.output_index ?? state.calls.size
      state.calls.set(index, {
        id: chunk.item.call_id || chunk.item.id,
        name: chunk.item.name,
        itemId: chunk.item.id,
        hasArgsDelta: false
      })
      return {
        type: 'tool_call',
        toolCall: { index, id: chunk.item.call_id || chunk.item.id, name: chunk.item.name }
      }
    }
    if (chunk.type === 'response.function_call_arguments.delta') {
      const index = chunk.output_index ?? this.findCallIndex(state.calls, chunk.item_id)
      const call = state.calls.get(index)
      if (call) call.hasArgsDelta = true
      return { type: 'tool_call', toolCall: { index, inputDelta: chunk.delta || '' } }
    }
    if (chunk.type === 'response.output_item.done' && chunk.item?.type === 'function_call') {
      const index = chunk.output_index ?? this.findCallIndex(state.calls, chunk.item.id)
      const call = state.calls.get(index)
      if (call?.hasArgsDelta) return { type: 'content', delta: '' }
      return {
        type: 'tool_call',
        toolCall: {
          index,
          id: chunk.item.call_id || chunk.item.id,
          name: chunk.item.name,
          inputDelta: chunk.item.arguments || ''
        }
      }
    }
    if (chunk.type === 'response.completed' || chunk.type === 'response.incomplete') {
      const response = chunk.response || {}
      const hasToolCalls = (response.output || []).some((item: any) => item.type === 'function_call')
      return {
        type: 'done',
        finishReason: mapCodexFinishReason(response, hasToolCalls),
        usage: mapUsage(response.usage)
      }
    }
    if (chunk.type === 'response.failed' || chunk.type === 'error') {
      return { type: 'done', finishReason: 'error' }
    }
    return { type: 'content', delta: '' }
  }

  async embed(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const error: any = new Error('Codex subscription providers do not support embeddings')
    error._providerError = true
    error._statusCode = 501
    error._errorBody = {
      message: error.message,
      type: 'not_supported',
      code: 'embeddings_unavailable'
    }
    error._source = this.config.name
    throw error
  }

  getModels(): ModelInfo[] {
    return this.config.models.map(model => ({
      id: `${this.config.name}/${model.id}`,
      provider: this.config.name,
      name: model.id,
      display_name: model.display_name,
      capabilities: model.capabilities
    }))
  }

  private convertContentBlock(block: ContentBlock, assistant: boolean): any {
    if (block.type === 'text') {
      return { type: assistant ? 'output_text' : 'input_text', text: block.text || '' }
    }
    if (block.type === 'image') {
      const imageUrl = block.imageUrl || (
        block.imageBase64
          ? `data:${block.imageMediaType || 'image/png'};base64,${block.imageBase64}`
          : undefined
      )
      return imageUrl ? { type: 'input_image', image_url: imageUrl } : null
    }
    return null
  }

  private convertToolOutput(content: Content): any {
    if (typeof content === 'string') return content
    const parts = content
      .map(block => this.convertContentBlock(block, false))
      .filter(Boolean)
    if (parts.length === 1 && parts[0].type === 'input_text') return parts[0].text
    return parts
  }

  private convertToolChoice(choice: LLMRequest['toolChoice']): any {
    if (!choice) return undefined
    if (typeof choice === 'string') return choice
    return { type: 'function', name: choice.name }
  }

  private responsesUrl(): string {
    return `${this.config.connection.base_url.replace(/\/$/, '')}/responses`
  }

  private async headers(): Promise<CodexHeaders> {
    const active = await ensureCodexAccessToken(this.config)
    const deviceId = active.connection.device_id || ''
    const headers: CodexHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Authorization': `Bearer ${active.connection.api_key}`,
      'x-codex-installation-id': deviceId,
      'originator': 'llmhub'
    }
    const accountId = active.connection.account_id
      || extractChatGptAccountId(active.connection.id_token)
      || extractChatGptAccountId(active.connection.api_key)
    if (accountId) headers['ChatGPT-Account-Id'] = accountId
    return headers
  }

  private async providerError(response: Response): Promise<any> {
    const text = await response.text().catch(() => '')
    let body: any
    try { body = JSON.parse(text) } catch { body = { message: text || response.statusText } }
    const error: any = new Error(JSON.stringify(body))
    error._providerError = true
    error._statusCode = response.status
    error._errorBody = body
    error._source = this.config.name
    return error
  }

  private eventError(event: any): any {
    const body = event.error || event.response?.error || event
    const error: any = new Error(body.message || 'Codex request failed')
    error._providerError = true
    error._statusCode = 502
    error._errorBody = body
    error._source = this.config.name
    return error
  }

  private findCallIndex(calls: Map<number, any>, itemId: string | undefined): number {
    for (const [index, call] of calls) {
      if (call.itemId === itemId) return index
    }
    return calls.size
  }
}

function stripProviderPrefix(model?: string): string | undefined {
  if (!model) return undefined
  const slash = model.indexOf('/')
  return slash >= 0 ? model.slice(slash + 1) : model
}

function safeJsonParse(value: string): object {
  try { return JSON.parse(value) } catch { return {} }
}

function mapUsage(usage: any): { promptTokens: number; completionTokens: number } {
  return {
    promptTokens: usage?.input_tokens || 0,
    completionTokens: usage?.output_tokens || 0
  }
}

function mapCodexFinishReason(response: any, hasToolCalls: boolean): 'stop' | 'length' | 'tool_calls' | 'error' {
  if (response.status === 'failed' || response.error) return 'error'
  if (response.status === 'incomplete') {
    return response.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'error'
  }
  return hasToolCalls ? 'tool_calls' : 'stop'
}
