import type { H3Event } from 'h3'
import type { ProviderManager } from '../providers/manager'
import type { EmbeddingRequest, EmbeddingResponse, LLMRequest, LLMResponse, LLMStreamChunk, ProviderAdapter, Usage } from './types'
import { HookRegistry, requestHooks, type HookContext, type CompletionInfo } from './hooks'
import { EventRegistry, systemEvents } from './events'

// Keep completion work owned by the process rather than the HTTP response lifetime.
const pendingCompletions = new Set<Promise<void>>()

export async function drainCompletions(): Promise<void> {
  while (pendingCompletions.size) await Promise.all([...pendingCompletions])
}

function* responseChunks(response: LLMResponse): Generator<LLMStreamChunk> {
  const blocks = typeof response.content === 'string' ? [{ type: 'text' as const, text: response.content }] : response.content
  let toolIndex = 0
  const toolIds = new Set<string>()
  let logprobs = response.logprobs
  for (const block of blocks) {
    if (block.type === 'text') {
      // Response-level token metadata has no block offsets; emit it only once.
      yield { type: 'content', delta: block.text, logprobs }
      logprobs = undefined
    }
    if (block.type === 'thinking') {
      yield { type: 'thinking', delta: block.thinking, reasoningKind: block.reasoningKind }
      if (block.signature) yield { type: 'thinking', signature: block.signature }
    }
    if (block.type === 'redacted_thinking') {
      yield block.reasoningProvider === 'openai'
        ? { type: 'thinking', encryptedContent: block.data, reasoningProvider: 'openai' }
        : { type: 'opaque_reasoning', opaqueData: block.data, reasoningProvider: 'anthropic' }
    }
    if (block.type === 'tool_use' && block.toolUse) {
      toolIds.add(block.toolUse.id)
      const metadata = response.toolCalls?.find(tool => tool.id === block.toolUse!.id)
      yield { type: 'tool_call', toolCall: { index: toolIndex++, id: block.toolUse.id, name: block.toolUse.name,
        inputDelta: JSON.stringify(block.toolUse.input), thoughtSignature: metadata?.thoughtSignature } }
    }
  }
  for (const tool of response.toolCalls ?? []) {
    if (toolIds.has(tool.id)) continue
    yield { type: 'tool_call', toolCall: { index: toolIndex++, id: tool.id, name: tool.name,
      inputDelta: JSON.stringify(tool.input), thoughtSignature: tool.thoughtSignature } }
  }
  yield { type: 'done', finishReason: response.finishReason, usage: response.usage }
}

export interface StreamConsumer {
  onChunks(chunks: LLMStreamChunk[]): void | Promise<void>
  onDoneMarker?(): void | Promise<void>
  onChunkError(error: unknown): void
}

export class RequestPipeline {
  readonly context: HookContext
  private model?: string
  private usage?: Usage
  private failure?: unknown
  private completed = false
  private pluginResponse?: LLMResponse
  private responseSource?: CompletionInfo['responseSource']

  get hasResponse(): boolean { return this.pluginResponse !== undefined }
  private reportedErrors = new Set<unknown>()

  constructor(
    private manager: ProviderManager,
    private event: H3Event,
    incomingProtocol: string,
    private hooks: HookRegistry = requestHooks,
    private events: EventRegistry = systemEvents
  ) {
    this.context = { incomingProtocol, apiKeyRecord: event.context?._apiKeyRecord }
    event.node?.res.once?.('close', this.onClose)
  }

  private onClose = () => {
    if (!this.event.node.res.writableEnded && !this.completed) {
      // Continue observing upstream usage; closing the client is not upstream EOF.
      this.failure = new Error('Client disconnected')
    }
  }

  resolve(request: LLMRequest) {
    this.model = request.model
    const resolved = this.manager.resolveAdapter(request.model || '', this.context.incomingProtocol, request.stream)
    this.context.providerName = resolved?.providerName
    this.context.providerConfig = resolved ? this.manager.getProviderConfig(resolved.providerName) : undefined
    return resolved
  }

  async prepare(request: LLMRequest) {
    this.model = request.model
    Object.assign(this.context, this.manager.getRequestContext(request.model || ''))
    try {
      const result = await this.hooks.generation(request, this.context)
      request = result.request
      this.pluginResponse = result.response
      this.responseSource = result.responseSource
      this.model = request.model
      if (result.response) {
        this.usage = result.response.usage
        return { request, resolved: undefined }
      }
    } catch (error) {
      throw this.manager.buildGatewayError(error instanceof Error ? error.message : String(error), 500)
    }
    // Only select an upstream once every request hook has declined to answer.
    return { request, resolved: this.resolve(request) }
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    this.resolve({ model: request.model, messages: [], config: {} })
    const response = await this.manager.embed(request)
    if (response.model) {
      this.model = response.model.includes('/') || !this.context.providerName
        ? response.model : `${this.context.providerName}/${response.model}`
    }
    this.usage = { promptTokens: response.usage.totalTokens, completionTokens: 0 }
    return response
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.model = request.model
    const upstream = this.pluginResponse ?? await this.manager.callLLM(request)
    if (upstream.usage) this.usage = upstream.usage
    const response = await this.hooks.response(upstream, this.context)
    if (response.usage) this.usage = response.usage
    return response
  }

  openStream(request: LLMRequest, adapter?: ProviderAdapter): ReadableStream | Promise<ReadableStream> {
    if (this.pluginResponse) return new ReadableStream({ start(controller) { controller.close() } })
    if (!adapter) throw this.manager.buildGatewayError('Stream adapter not found', 500)
    return adapter.callStream(adapter.toProviderRequest({ ...request, stream: true }))
  }

  async consumeStream(stream: ReadableStream, adapter: ProviderAdapter | undefined, consumer: StreamConsumer): Promise<void> {
    if (this.pluginResponse) {
      for (const chunk of responseChunks(this.pluginResponse)) {
        try {
          if (chunk.usage) this.usage = chunk.usage
          await consumer.onChunks(await this.hooks.streamChunk(chunk, this.context))
        } catch (error) {
          await this.error(error)
          consumer.onChunkError(error)
        }
      }
      await consumer.onDoneMarker?.()
      return
    }
    if (!adapter) throw this.manager.buildGatewayError('Stream adapter not found', 500)
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
    await this.events.emit('llmhub:request-error', { error, context: this.context })
  }

  async complete(): Promise<void> {
    if (this.completed) return
    this.completed = true
    this.event.node?.res.removeListener?.('close', this.onClose)
    const completion = { model: this.model, usage: this.usage, error: this.failure,
      ...(this.responseSource ? { responseSource: this.responseSource } : {}) }
    const pending = this.events.emit('llmhub:request-complete', { completion, context: this.context }).catch(error => {
      console.error('[LLMHub] Completion failed:', error)
    })
    pendingCompletions.add(pending)
    void pending.then(() => pendingCompletions.delete(pending))
  }
}
