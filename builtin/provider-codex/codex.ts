import type {
  ContentBlock,
  EmbeddingRequest,
  EmbeddingResponse,
  LLMRequest,
  ModelInfo,
  ProviderAdapter,
  ProviderConfig
} from '../../server/core/types'
import { ResponsesCodec } from '../provider-openai/responses-codec'
import { fetchWithRetry } from '../../server/utils/fetch'
import { toResponsesFormat } from '../shared/structured-output'
import { extractChatGptAccountId } from './codex-auth'
import { ensureCodexAccessToken } from './codex-token-manager'
import { consumeSubscriptionResetCredit } from '../../server/services/subscription-usage'

type CodexHeaders = Record<string, string>

/**
 * Adapter for the ChatGPT-subscription Codex Responses backend.
 *
 * The upstream is stream-only. `call()` therefore consumes its SSE response and
 * returns the terminal Responses object for non-streaming gateway clients.
 */
export class CodexAdapter extends ResponsesCodec implements ProviderAdapter {
  name = 'codex-subscription'
  private resetInFlight?: Promise<boolean>

  constructor(config: ProviderConfig) { super(config) }

  override toProviderRequest(request: LLMRequest): any {
    const input: any[] = []

    for (const message of request.messages) {
      const blocks = typeof message.content === 'string'
        ? [{ type: 'text', text: message.content } as ContentBlock]
        : message.content

      const reasoningSummary = blocks
        .filter(block => block.type === 'thinking')
        .map(block => block.thinking || '')
        .join('')
      const encryptedReasoning = blocks.find(block => block.type === 'redacted_thinking' && block.reasoningProvider === 'openai')?.data
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
          role: message.role,
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

    const format = toResponsesFormat(request.config.outputFormat)
    if (format) payload.text = { format }

    const thinking = request.config.thinking
    const effort = thinking?.effort || request.config.reasoningEffort
    const summary = thinking?.summary || request.config.reasoningSummary
    if (effort || summary) {
      payload.reasoning = {
        ...(effort && effort !== 'none' ? { effort } : {}),
        summary: summary || (thinking?.includeSummary === false ? 'none' : 'auto')
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
    const requestBody = JSON.stringify({ ...request, stream: true, store: false })
    let response = await fetchWithRetry(this.responsesUrl(), {
      method: 'POST',
      headers: await this.headers(),
      body: requestBody
    }, this.config.connection)

    if (response.status === 429 && await this.tryAutomaticReset()) {
      response = await fetchWithRetry(this.responsesUrl(), {
        method: 'POST',
        headers: await this.headers(),
        body: requestBody
      }, this.config.connection)
    }
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

  async callStream(request: any): Promise<ReadableStream> {
    const adapter = this
    const config = this.config
    const url = this.responsesUrl()
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const abortController = new AbortController()
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    if (config.connection.enable_timeout) {
      timeoutId = setTimeout(
        () => abortController.abort(),
        config.connection.timeout || 30000
      )
    }

    const requestBody = JSON.stringify({ ...request, stream: true, store: false })
    const sendRequest = async () => fetch(url, {
      method: 'POST',
      headers: await adapter.headers(),
      body: requestBody,
      signal: abortController.signal
    })

    let response: Response
    try {
      response = await sendRequest()
      if (response.status === 429 && await adapter.tryAutomaticReset()) {
        response = await sendRequest()
      }
      if (!response.ok) throw await adapter.providerError(response)
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }

    return new ReadableStream({
      start(controller) {
        ;(async () => {
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
          const enqueueLine = (line: string) => {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) return
            const data = trimmed.slice(5).trim()
            if (data && data !== '[DONE]') {
              let event: any
              try { event = JSON.parse(data) } catch {}
              if (
                event?.type === 'response.failed' ||
                event?.type === 'error' ||
                event?.code === 'rate_limit_exceeded'
              ) {
                throw adapter.eventError(event)
              }
            }
            controller.enqueue(encoder.encode(`data: ${data}\n\n`))
          }

          try {
            reader = response.body?.getReader()
            if (!reader) throw new Error('Codex response has no body')
            let buffer = ''
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split(/\r?\n/)
              buffer = lines.pop() || ''
              for (const line of lines) enqueueLine(line)
            }
            if (buffer.trim()) enqueueLine(buffer)
          } catch (error) {
            fail(error)
          } finally {
            if (reader) reader.cancel().catch(() => {})
            close()
          }
        })()
      }
    })
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

  private tryAutomaticReset(): Promise<boolean> {
    if (this.config.connection.auto_reset_on_quota_exhausted !== true) {
      return Promise.resolve(false)
    }
    if (this.resetInFlight) return this.resetInFlight

    const attempt = consumeSubscriptionResetCredit(this.config)
      .then(result => result.code === 'reset')
      .catch((error: any) => {
        console.warn(`Unable to automatically use a Codex reset for ${this.config.name}:`, error?.message || error)
        return false
      })
    this.resetInFlight = attempt
    attempt.finally(() => {
      if (this.resetInFlight === attempt) this.resetInFlight = undefined
    })
    return attempt
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

}

function stripProviderPrefix(model?: string): string | undefined {
  if (!model) return undefined
  const slash = model.indexOf('/')
  return slash >= 0 ? model.slice(slash + 1) : model
}
