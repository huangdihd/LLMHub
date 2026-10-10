import type { H3Event } from 'h3'
import type { ProviderManager } from '../providers/manager'
import type { LLMRequest, LLMResponse, LLMStreamChunk, ProviderAdapter, Usage } from './types'
import { HookRegistry, requestHooks, type HookContext } from './hooks'
import { normalizationHooks } from './builtin-hooks'
import { incrementCalls, trackUsage } from '../utils/stats'

export interface StreamConsumer {
  onChunks(chunks: LLMStreamChunk[]): void | Promise<void>
  onDoneMarker?(): void | Promise<void>
  onChunkError(error: unknown): void
}

export class RequestPipeline {
  readonly context: HookContext
  private usage?: Usage
  private failure?: unknown
  private completed = false
  private reportedErrors = new Set<unknown>()

  constructor(
    private manager: ProviderManager,
    private event: H3Event,
    incomingProtocol: string,
    private hooks: HookRegistry = requestHooks
  ) {
    this.context = { incomingProtocol, apiKeyRecord: event.context?._apiKeyRecord }
  }

  resolve(request: LLMRequest) {
    const resolved = this.manager.resolveAdapter(request.model || '', this.context.incomingProtocol, request.stream)
    this.context.providerName = resolved?.providerName
    this.context.providerConfig = resolved ? this.manager.getProviderConfig(resolved.providerName) : undefined
    return resolved
  }

  async prepare(request: LLMRequest) {
    let resolved = this.resolve(request)
    const model = request.model
    try {
      request = await this.hooks.request(request, this.context)
    } catch (error) {
      throw this.manager.buildGatewayError(error instanceof Error ? error.message : String(error), 500)
    }
    // A request hook may route to another model; never send it through the old adapter.
    if (request.model !== model) resolved = this.resolve(request)
    return { request, resolved }
  }

  async normalizeRequest(request: LLMRequest): Promise<LLMRequest> {
    try {
      return await normalizationHooks.request(request, this.context)
    } catch (error) {
      throw this.manager.buildGatewayError(error instanceof Error ? error.message : String(error), 500)
    }
  }

  incrementCalls(): Promise<void> {
    return incrementCalls()
  }

  trackUsage(usage: number | Usage, model?: string): Promise<void> {
    if (typeof usage !== 'number') this.usage = usage
    return trackUsage(this.event, usage, model)
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    const response = await this.hooks.response(await this.manager.callLLM(request), this.context)
    if (response.usage) this.usage = response.usage
    return response
  }

  openStream(request: LLMRequest, adapter: ProviderAdapter): ReadableStream | Promise<ReadableStream> {
    return adapter.callStream(adapter.toProviderRequest({ ...request, stream: true }))
  }

  async consumeStream(stream: ReadableStream, adapter: ProviderAdapter, consumer: StreamConsumer): Promise<void> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    const providerState = {}
    let lineBuffer = ''

    const processLine = async (line: string) => {
      if (!line.startsWith('data: ')) return
      const data = line.slice(6).trim()
      if (data === '[DONE]') {
        await consumer.onDoneMarker?.()
        return
      }
      if (!data) return
      try {
        const converted = adapter.fromProviderStreamChunk(JSON.parse(data), providerState)
        const chunks = Array.isArray(converted) ? converted : [converted]
        const output: LLMStreamChunk[] = []
        for (const chunk of chunks) {
          if (chunk.usage) this.usage = chunk.usage
          output.push(...await this.hooks.streamChunk(chunk, this.context))
        }
        await consumer.onChunks(output)
      } catch (error) {
        await this.error(error)
        consumer.onChunkError(error)
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      lineBuffer += decoder.decode(value, { stream: true })
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() || ''
      for (const line of lines) await processLine(line)
    }
    if (lineBuffer.trim()) await processLine(lineBuffer.trim())
  }

  async error(error: unknown): Promise<void> {
    if (this.reportedErrors.has(error)) return
    this.reportedErrors.add(error)
    this.failure = error
    await this.hooks.error(error, this.context)
  }

  async complete(): Promise<void> {
    if (this.completed) return
    this.completed = true
    await this.hooks.complete({ usage: this.usage, error: this.failure }, this.context)
  }
}
