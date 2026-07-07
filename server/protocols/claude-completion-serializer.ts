import type { ProtocolSerializer, LLMResponse, LLMStreamChunk } from '../core/types'

function mapCompletionStopReason(reason: string | undefined): string {
  if (reason === 'length') return 'max_tokens'
  return 'stop_sequence'
}

export class ClaudeCompletionSerializer implements ProtocolSerializer {
  name = 'claude-completion'

  private completionId = `compl_${Date.now()}${Math.random().toString(36).slice(2, 8)}`

  serializeResponse(response: LLMResponse): any {
    let text = ''
    if (typeof response.content === 'string') {
      text = response.content
    } else {
      for (const block of response.content) {
        if (block.type === 'text') text += block.text || ''
      }
    }

    return {
      id: this.completionId,
      type: 'completion',
      completion: text,
      stop_reason: mapCompletionStopReason(response.finishReason),
      model: 'llmhub'
    }
  }

  serializeStreamChunk(chunk: LLMStreamChunk): any {
    if (chunk.type === 'done') {
      return {
        id: this.completionId,
        type: 'completion',
        completion: '',
        stop_reason: mapCompletionStopReason(chunk.finishReason),
        model: 'llmhub'
      }
    }

    return {
      id: this.completionId,
      type: 'completion',
      completion: chunk.type === 'content' ? (chunk.delta || '') : '',
      stop_reason: null,
      model: 'llmhub'
    }
  }
}
