import type { ProtocolSerializer, LLMResponse, LLMStreamChunk } from '../core/types'

function mapClaudeStopReason(reason: string | undefined): string {
  if (reason === 'tool_calls') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  return 'end_turn'
}

export class ClaudeMessagesSerializer implements ProtocolSerializer {
  name = 'claude-messages'

  serializeResponse(response: LLMResponse): any {
    const content: any[] = []

    if (typeof response.content === 'string') {
      content.push({ type: 'text', text: response.content })
    } else {
      for (const block of response.content) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text })
        } else if (block.type === 'thinking') {
          content.push({ type: 'thinking', thinking: block.thinking, ...(block.signature ? { signature: block.signature } : {}) })
        } else if (block.type === 'redacted_thinking') {
          content.push({ type: 'redacted_thinking', data: block.data ?? block.signature })
        }
      }
    }

    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const tc of response.toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input
        })
      }
    }

    return {
      id: `msg-${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content,
      model: 'llmhub',
      stop_reason: mapClaudeStopReason(response.finishReason),
      stop_sequence: null,
      usage: {
        input_tokens: response.usage.promptTokens,
        output_tokens: response.usage.completionTokens
      }
    }
  }

  serializeStreamChunk(chunk: LLMStreamChunk): any {
    if (chunk.type === 'done') {
      return {
        type: 'message_delta',
        delta: {
          stop_reason: mapClaudeStopReason(chunk.finishReason)
        },
        usage: {
          output_tokens: chunk.usage?.completionTokens || 0
        }
      }
    }

    if (chunk.type === 'content') {
      return {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: chunk.delta || ''
        }
      }
    }

    if (chunk.type === 'thinking') {
      return {
        type: 'content_block_delta',
        index: 0,
        delta: chunk.signature
          ? { type: 'signature_delta', signature: chunk.signature }
          : { type: 'thinking_delta', thinking: chunk.delta || '' }
      }
    }

    if (chunk.type === 'tool_call' && chunk.toolCall) {
      if (chunk.toolCall.id) {
        return {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'tool_use',
            id: chunk.toolCall.id,
            name: chunk.toolCall.name
          }
        }
      }
      return {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: chunk.toolCall.inputDelta || ''
        }
      }
    }

    return {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '' }
    }
  }
}
