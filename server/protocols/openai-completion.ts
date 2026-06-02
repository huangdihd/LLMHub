import type { ProtocolParser, LLMRequest, LLMStreamChunk } from '../core/types'

export class OpenAICompletionParser implements ProtocolParser {
  name = 'openai-completion'

  canHandle(url: string, method: string, body: any): boolean {
    return url.includes('/v1/completions') && method === 'POST' && !url.includes('/chat')
  }

  parseRequest(body: any): LLMRequest {
    const prompt = body.prompt || ''

    return {
      model: body.model,
      messages: [{ role: 'user', content: prompt }],
      config: {
        maxTokens: body.max_tokens || 4096,
        temperature: body.temperature,
        topP: body.top_p,
        stop: body.stop
      },
      stream: body.stream
    }
  }

  parseStreamChunk(chunk: any): LLMStreamChunk {
    const choice = chunk.choices?.[0]
    if (!choice) {
      return { type: 'done' }
    }

    if (choice.finish_reason) {
      return { type: 'done', finishReason: 'stop' }
    }

    return { type: 'content', delta: choice.text || '' }
  }
}
