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
        maxTokens: body.max_tokens_to_sample || 4096,
        temperature: body.temperature,
        topP: body.top_p,
        stop: body.stop_sequences
      },
      stream: body.stream
    }
  }

  parseStreamChunk(chunk: any): LLMStreamChunk {
    if (chunk.type === 'completion_stop') {
      return { type: 'done' }
    }

    if (chunk.type === 'completion_delta') {
      return { type: 'content', delta: chunk.completion || '' }
    }

    return { type: 'content', delta: '' }
  }
}
