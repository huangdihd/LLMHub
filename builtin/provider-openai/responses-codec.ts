import type { Content, ContentBlock, LLMRequest, LLMResponse, LLMStreamChunk, ProviderConfig, ToolCall } from '../../server/core/types'
import { toResponsesFormat } from '../../server/utils/structured-output'

// Lifecycle and full-text mirrors are deliberately ignored after their deltas.
const ignoredResponseEvents = new Set([
  'response.created', 'response.in_progress', 'response.queued',
  'response.output_item.added', 'response.output_item.done',
  'response.content_part.added', 'response.content_part.done',
  'response.output_text.done', 'response.refusal.done',
  'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.done', 'response.function_call_arguments.done'
])

/** Shared wire mapping only: no authentication or transport policy. */
export class ResponsesCodec {
  constructor(protected config: ProviderConfig) {}

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
      stream: request.stream || false,
      temperature: request.config.temperature,
      top_p: request.config.topP,
      max_output_tokens: request.config.maxTokens
    }

    const format = toResponsesFormat(request.config.outputFormat)
    if (format) payload.text = { format }

    if (request.config.topLogprobs != null || request.config.logprobs) {
      payload.top_logprobs = request.config.topLogprobs ?? 0
      payload.include = ['message.output_text.logprobs']
    }

    const thinking = request.config.thinking
    const effort = thinking?.effort || request.config.reasoningEffort
    const summary = thinking?.summary || request.config.reasoningSummary
    if (effort || summary) {
      payload.reasoning = {
        ...(effort ? { effort } : {}),
        ...(thinking?.includeSummary === false ? {} : { summary: summary || 'auto' })
      }
      payload.include = [...(payload.include || []), 'reasoning.encrypted_content']
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

  fromProviderResponse(response: any): LLMResponse {
    const content: ContentBlock[] = []
    const toolCalls: ToolCall[] = []
    const logprobs = (response.output || []).flatMap((item: any) =>
      (item.content || []).flatMap((part: any) => part.logprobs || []))

    for (const item of response.output || []) {
      if (item.type === 'reasoning') {
        const summary = (item.summary || []).map((part: any) => part.text || '').join('')
        if (summary) content.push({ type: 'thinking', thinking: summary, reasoningKind: 'summary' })
        const raw = (item.content || [])
          .filter((part: any) => part.type === 'reasoning_text')
          .map((part: any) => part.text || '').join('')
        if (raw) content.push({ type: 'thinking', thinking: raw, reasoningKind: 'raw' })
        if (item.encrypted_content) {
          content.push({ type: 'redacted_thinking', signature: item.encrypted_content, data: item.encrypted_content, reasoningProvider: 'openai' })
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
      finishReason: mapResponsesFinishReason(response, toolCalls.length > 0),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      usage: mapUsage(response.usage),
      ...(logprobs.length ? { logprobs } : {})
    }
  }

  fromProviderStreamChunk(chunk: any, state: any = {}): LLMStreamChunk | LLMStreamChunk[] {
    state.calls ||= new Map<number, any>()

    if (chunk.type === 'response.output_text.delta' || chunk.type === 'response.refusal.delta') {
      return { type: 'content', delta: chunk.delta || '', ...(chunk.logprobs?.length ? { logprobs: chunk.logprobs } : {}) }
    }
    if (chunk.type === 'response.reasoning_summary_text.delta') {
      return { type: 'thinking', delta: chunk.delta || '', reasoningKind: 'summary' }
    }
    if (chunk.type === 'response.reasoning_text.delta' || chunk.type === 'response.reasoning_text.done') {
      state.rawReasoningParts ||= new Set<string>()
      const key = JSON.stringify([chunk.item_id ?? chunk.output_index, chunk.content_index ?? 0])
      if (chunk.type === 'response.reasoning_text.delta') {
        if (chunk.delta) state.rawReasoningParts.add(key)
        return { type: 'thinking', delta: chunk.delta || '', reasoningKind: 'raw' }
      }
      // Done carries the whole part, not another delta. Also tolerate done-only streams.
      if (state.rawReasoningParts.has(key)) return { type: 'content', delta: '' }
      state.rawReasoningParts.add(key)
      return { type: 'thinking', delta: chunk.text || '', reasoningKind: 'raw' }
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
        finishReason: mapResponsesFinishReason(response, hasToolCalls),
        usage: mapUsage(response.usage)
      }
    }
    if (chunk.type === 'response.failed' || chunk.type === 'error') {
      return { type: 'done', finishReason: 'error' }
    }
    if (!ignoredResponseEvents.has(chunk.type)) {
      state.unknownEventTypes ||= new Set<string>()
      if (!state.unknownEventTypes.has(chunk.type)) {
        state.unknownEventTypes.add(chunk.type)
        console.warn(`[LLMHub] Responses provider ${this.config.name}: unknown event type ${String(chunk.type)}`)
      }
    }
    return { type: 'content', delta: '' }
  }

  protected convertContentBlock(block: ContentBlock, assistant: boolean): any {
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

  protected convertToolOutput(content: Content): any {
    if (typeof content === 'string') return content
    const parts = content
      .map(block => this.convertContentBlock(block, false))
      .filter(Boolean)
    if (parts.length === 1 && parts[0].type === 'input_text') return parts[0].text
    return parts
  }

  protected convertToolChoice(choice: LLMRequest['toolChoice']): any {
    if (!choice) return undefined
    if (typeof choice === 'string') return choice
    return { type: 'function', name: choice.name }
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

function mapUsage(usage: any): { promptTokens: number; completionTokens: number; cachedTokens?: number } {
  const cachedTokens = usage?.input_tokens_details?.cached_tokens
  return {
    promptTokens: usage?.input_tokens || 0,
    completionTokens: usage?.output_tokens || 0,
    ...(cachedTokens != null ? { cachedTokens } : {})
  }
}

function mapResponsesFinishReason(response: any, hasToolCalls: boolean): 'stop' | 'length' | 'tool_calls' | 'error' {
  if (response.status === 'failed' || response.error) return 'error'
  if (response.status === 'incomplete') {
    return response.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'error'
  }
  return hasToolCalls ? 'tool_calls' : 'stop'
}
