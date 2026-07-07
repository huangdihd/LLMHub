import type { ProtocolSerializer, LLMResponse, LLMStreamChunk, Usage } from '../core/types'

export interface ResponsesStreamEvent {
  event: string
  data: any
}

export class OpenAIResponsesSerializer implements ProtocolSerializer {
  name = 'openai-responses'

  private responseId = `resp_${Date.now()}${Math.random().toString(36).slice(2, 8)}`
  private createdAt = Math.floor(Date.now() / 1000)
  private sequenceNumber = 0
  private outputIndex = -1
  private idCounter = 0
  private currentItem: any = null
  private completedItems: any[] = []

  private nextId(prefix: string): string {
    return `${prefix}_${Date.now()}${(this.idCounter++).toString(36)}`
  }

  private buildResponseObject(status: string, output: any[], usage: any, incompleteDetails: any = null): any {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status,
      error: null,
      incomplete_details: incompleteDetails,
      instructions: null,
      max_output_tokens: null,
      model: 'llmhub',
      output,
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoning: { effort: null, summary: null },
      store: false,
      temperature: null,
      text: { format: { type: 'text' } },
      tool_choice: 'auto',
      tools: [],
      top_p: null,
      truncation: 'disabled',
      usage,
      user: null,
      metadata: {}
    }
  }

  private mapUsage(usage?: Usage): any {
    const promptTokens = usage?.promptTokens || 0
    const completionTokens = usage?.completionTokens || 0
    return {
      input_tokens: promptTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: completionTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: promptTokens + completionTokens
    }
  }

  serializeResponse(response: LLMResponse): any {
    const output: any[] = []
    let text = ''
    let thinking = ''

    if (typeof response.content === 'string') {
      text = response.content
    } else {
      for (const block of response.content) {
        if (block.type === 'text') text += block.text || ''
        else if (block.type === 'thinking') thinking += block.thinking || ''
      }
    }

    if (thinking) {
      output.push({
        type: 'reasoning',
        id: this.nextId('rs'),
        summary: [{ type: 'summary_text', text: thinking }]
      })
    }

    const hasToolCalls = !!(response.toolCalls && response.toolCalls.length > 0)

    if (text || !hasToolCalls) {
      output.push({
        type: 'message',
        id: this.nextId('msg'),
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }]
      })
    }

    if (hasToolCalls) {
      for (const tc of response.toolCalls!) {
        output.push({
          type: 'function_call',
          id: this.nextId('fc'),
          call_id: tc.id,
          name: tc.name,
          arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
          status: 'completed'
        })
      }
    }

    const incomplete = response.finishReason === 'length'
    return this.buildResponseObject(
      incomplete ? 'incomplete' : 'completed',
      output,
      this.mapUsage(response.usage),
      incomplete ? { reason: 'max_output_tokens' } : null
    )
  }

  private event(type: string, data: any): ResponsesStreamEvent {
    return { event: type, data: { type, ...data, sequence_number: this.sequenceNumber++ } }
  }

  startEvents(): ResponsesStreamEvent[] {
    return [
      this.event('response.created', { response: this.buildResponseObject('in_progress', [], null) }),
      this.event('response.in_progress', { response: this.buildResponseObject('in_progress', [], null) })
    ]
  }

  serializeStreamChunk(chunk: LLMStreamChunk): ResponsesStreamEvent[] {
    if (chunk.type === 'done') {
      const events = this.closeCurrentItem()
      const incomplete = chunk.finishReason === 'length'
      const finalResponse = this.buildResponseObject(
        incomplete ? 'incomplete' : 'completed',
        this.completedItems,
        this.mapUsage(chunk.usage),
        incomplete ? { reason: 'max_output_tokens' } : null
      )
      events.push(this.event(incomplete ? 'response.incomplete' : 'response.completed', { response: finalResponse }))
      return events
    }

    if (chunk.type === 'content') {
      const events = this.ensureItem('message')
      this.currentItem.text += chunk.delta || ''
      events.push(this.event('response.output_text.delta', {
        item_id: this.currentItem.id,
        output_index: this.outputIndex,
        content_index: 0,
        delta: chunk.delta || '',
        logprobs: []
      }))
      return events
    }

    if (chunk.type === 'thinking') {
      const events = this.ensureItem('reasoning')
      this.currentItem.text += chunk.delta || ''
      events.push(this.event('response.reasoning_summary_text.delta', {
        item_id: this.currentItem.id,
        output_index: this.outputIndex,
        summary_index: 0,
        delta: chunk.delta || ''
      }))
      return events
    }

    if (chunk.type === 'tool_call' && chunk.toolCall) {
      const tc = chunk.toolCall
      const events: ResponsesStreamEvent[] = []
      // A chunk carrying an id starts a new call; delta-only chunks append to the current one
      if (tc.id || this.currentItem?.type !== 'function_call') {
        events.push(...this.closeCurrentItem())
        this.outputIndex++
        this.currentItem = {
          type: 'function_call',
          id: this.nextId('fc'),
          callId: tc.id || this.nextId('call'),
          toolName: tc.name || '',
          args: ''
        }
        events.push(this.event('response.output_item.added', {
          output_index: this.outputIndex,
          item: {
            type: 'function_call',
            id: this.currentItem.id,
            call_id: this.currentItem.callId,
            name: this.currentItem.toolName,
            arguments: '',
            status: 'in_progress'
          }
        }))
      }
      if (tc.name && !this.currentItem.toolName) this.currentItem.toolName = tc.name
      if (tc.inputDelta) {
        this.currentItem.args += tc.inputDelta
        events.push(this.event('response.function_call_arguments.delta', {
          item_id: this.currentItem.id,
          output_index: this.outputIndex,
          delta: tc.inputDelta
        }))
      }
      return events
    }

    return []
  }

  private ensureItem(type: 'message' | 'reasoning'): ResponsesStreamEvent[] {
    if (this.currentItem?.type === type) return []
    const events = this.closeCurrentItem()
    this.outputIndex++
    const id = this.nextId(type === 'message' ? 'msg' : 'rs')
    this.currentItem = { type, id, text: '' }

    if (type === 'message') {
      events.push(this.event('response.output_item.added', {
        output_index: this.outputIndex,
        item: { type: 'message', id, status: 'in_progress', role: 'assistant', content: [] }
      }))
      events.push(this.event('response.content_part.added', {
        item_id: id,
        output_index: this.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] }
      }))
    } else {
      events.push(this.event('response.output_item.added', {
        output_index: this.outputIndex,
        item: { type: 'reasoning', id, summary: [] }
      }))
      events.push(this.event('response.reasoning_summary_part.added', {
        item_id: id,
        output_index: this.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: '' }
      }))
    }
    return events
  }

  private closeCurrentItem(): ResponsesStreamEvent[] {
    const item = this.currentItem
    if (!item) return []
    const events: ResponsesStreamEvent[] = []

    if (item.type === 'message') {
      events.push(this.event('response.output_text.done', {
        item_id: item.id,
        output_index: this.outputIndex,
        content_index: 0,
        text: item.text,
        logprobs: []
      }))
      events.push(this.event('response.content_part.done', {
        item_id: item.id,
        output_index: this.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: item.text, annotations: [] }
      }))
      const full = {
        type: 'message',
        id: item.id,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: item.text, annotations: [] }]
      }
      events.push(this.event('response.output_item.done', { output_index: this.outputIndex, item: full }))
      this.completedItems.push(full)
    } else if (item.type === 'function_call') {
      events.push(this.event('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: this.outputIndex,
        arguments: item.args
      }))
      const full = {
        type: 'function_call',
        id: item.id,
        call_id: item.callId,
        name: item.toolName,
        arguments: item.args,
        status: 'completed'
      }
      events.push(this.event('response.output_item.done', { output_index: this.outputIndex, item: full }))
      this.completedItems.push(full)
    } else {
      events.push(this.event('response.reasoning_summary_text.done', {
        item_id: item.id,
        output_index: this.outputIndex,
        summary_index: 0,
        text: item.text
      }))
      events.push(this.event('response.reasoning_summary_part.done', {
        item_id: item.id,
        output_index: this.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: item.text }
      }))
      const full = {
        type: 'reasoning',
        id: item.id,
        summary: [{ type: 'summary_text', text: item.text }]
      }
      events.push(this.event('response.output_item.done', { output_index: this.outputIndex, item: full }))
      this.completedItems.push(full)
    }

    this.currentItem = null
    return events
  }
}
