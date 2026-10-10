import type { EmbeddingRequest, EmbeddingResponse, ModelInfo, ProviderAdapter, ProviderConfig } from '../../server/core/types'
import { OpenAIAdapter } from './openai'
import { ResponsesCodec } from './responses-codec'
import { fetchWithRetry } from '../../server/utils/fetch'

/** API-key Responses transport, deliberately separate from the Codex OAuth backend. */
export class OpenAIResponsesAdapter extends ResponsesCodec implements ProviderAdapter {
  name = 'openai'

  constructor(config: ProviderConfig) { super(config) }

  private providerError(body: any, status = 502): Error {
    const error: any = new Error(body?.error?.message || body?.message || 'OpenAI Responses request failed')
    error._providerError = true
    error._statusCode = status
    error._errorBody = body
    error._source = this.config.name
    return error
  }

  private async send(request: any, stream: boolean) {
    const abort = new AbortController()
    const timer = this.config.connection.enable_timeout !== false
      ? setTimeout(() => abort.abort(), this.config.connection.timeout || 30000)
      : undefined
    const cleanup = () => { if (timer) clearTimeout(timer) }
    try {
      const response = await fetch(`${this.config.connection.base_url.replace(/\/+$/, '')}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: stream ? 'text/event-stream' : 'application/json',
          Authorization: `Bearer ${this.config.connection.api_key}`
        },
        body: JSON.stringify({ ...request, stream }),
        signal: abort.signal
      })
      if (!response.ok) {
        const text = await response.text()
        let body: any
        try { body = JSON.parse(text) } catch { body = { message: text || response.statusText } }
        throw this.providerError(body, response.status)
      }
      return { response, abort, cleanup }
    } catch (error) {
      cleanup()
      throw error
    }
  }

  async call(request: any): Promise<any> {
    const response = await fetchWithRetry(`${this.config.connection.base_url.replace(/\/+$/, '')}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${this.config.connection.api_key}` },
      body: JSON.stringify({ ...request, stream: false })
    }, this.config.connection)
    if (!response.ok) {
      const text = await response.text()
      let body: any
      try { body = JSON.parse(text) } catch { body = { message: text || response.statusText } }
      throw this.providerError(body, response.status)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const reader = response.body?.getReader()
    if (!reader) throw this.providerError({ message: 'OpenAI Responses response has no body' })
    try {
      const bodyRead = (async () => {
        const decoder = new TextDecoder()
        let text = ''
        while (true) {
          const { value, done } = await reader.read()
          text += decoder.decode(value, { stream: !done })
          if (done) return JSON.parse(text)
        }
      })()
      const body = this.config.connection.enable_timeout === false ? await bodyRead : await Promise.race([
        bodyRead,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('OpenAI Responses body read timeout'))
            void reader.cancel().catch(() => {})
          }, this.config.connection.timeout || 30000)
        })
      ])
      if (body.error || body.status === 'failed') throw this.providerError(body)
      return body
    } finally {
      if (timer) clearTimeout(timer)
      reader.releaseLock()
    }
  }

  async callStream(request: any): Promise<ReadableStream> {
    const { response, abort, cleanup } = await this.send(request, true)
    cleanup() // Header deadline is separate from the per-read idle deadline.
    const timeout = this.config.connection.enable_timeout !== false ? (this.config.connection.timeout || 30000) : 0
    const reader = response.body?.getReader()
    if (!reader) {
      cleanup()
      throw this.providerError({ message: 'OpenAI Responses response has no body' })
    }
    const read = async () => {
      if (!timeout) return reader.read()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              abort.abort()
              reject(new Error(`Upstream stream read timeout (${timeout}ms)`))
            }, timeout)
          })
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    let buffer = ''
    let terminal = false
    let emitted = 0
    const emit = (line: string, controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (!line.startsWith('data:')) return
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') return
      const event = JSON.parse(data)
      if (event.type === 'error' || event.type === 'response.failed') {
        throw this.providerError(event.response || event)
      }
      if (event.type === 'response.completed' || event.type === 'response.incomplete') terminal = true
      controller.enqueue(encoder.encode(`data: ${data}\n\n`))
      emitted++
    }
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          // A network chunk can end mid-event. Keep reading until there is data
          // to enqueue; otherwise a pending downstream read may never pull again.
          const previousEmitted = emitted
          while (emitted === previousEmitted) {
            const { value, done } = await read()
            buffer += decoder.decode(value, { stream: !done })
            const lines = buffer.split(/\r?\n/)
            buffer = lines.pop() || ''
            for (const line of lines) emit(line, controller)
            if (done) {
              if (buffer.trim()) emit(buffer, controller)
              if (!terminal) throw new Error('OpenAI Responses stream ended without a terminal response')
              cleanup()
              reader.releaseLock()
              controller.close()
              return
            }
          }
        } catch (error) {
          cleanup()
          abort.abort()
          await reader.cancel().catch(() => {})
          controller.error(error)
        }
      },
      async cancel(reason) {
        cleanup()
        abort.abort()
        await reader.cancel(reason).catch(() => {})
      }
    })
  }

  // Changing the generation endpoint must not remove standard API-key embeddings.
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    return new OpenAIAdapter(this.config).embed(request)
  }

  getModels(): ModelInfo[] {
    return new OpenAIAdapter(this.config).getModels()
  }
}
