import type { ProtocolParser, LLMRequest, LLMStreamChunk } from '../core/types'

export class ClaudeCompletionParser implements ProtocolParser {
  name = 'claude-completion'

  canHandle(url: string, method: string, body: any): boolean {
    return url.includes('/v1/complete') && method === 'POST'
  }

  parseRequest(body: any): LLMRequest {
    const prompt = body.prompt || ''

    return {
      model: body.model,
      messages: [{ role: 'user', content: prompt }],
      config: {
        maxTokens: body.max_tokens_to_sample ?? undefined,
        temperature: body.temperature,
        topP: body.top_p,
        stop: body.stop_sequences
      },
      stream: body.stream
    }
  }

  parseStreamChunk(chunk: any): LLMStreamChunk {
    // Legacy Text Completions streams a single event type: 'completion'
    // { type: 'completion', completion: '...', stop_reason: null | 'stop_sequence' | 'max_tokens' }
    if (chunk.type === 'completion') {
      if (chunk.stop_reason) {
        return {
          type: 'done',
          finishReason: chunk.stop_reason === 'max_tokens' ? 'length' : 'stop'
        }
      }
      return { type: 'content', delta: chunk.completion || '' }
    }

    return { type: 'content', delta: '' }
  }
}
