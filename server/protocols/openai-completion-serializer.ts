import type { ProtocolSerializer, LLMResponse, LLMStreamChunk } from '../core/types'

function mapCompletionFinishReason(reason: string | undefined): string {
  if (reason === 'length') return 'length'
  return 'stop'
}

export class OpenAICompletionSerializer implements ProtocolSerializer {
  name = 'openai-completion'

  // The legacy Completions stream reuses one id for every chunk
  private completionId = `cmpl-${Date.now()}${Math.random().toString(36).slice(2, 8)}`
  private createdAt = Math.floor(Date.now() / 1000)

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
      object: 'text_completion',
      created: this.createdAt,
      model: 'llmhub',
      choices: [{
        text,
        index: 0,
        logprobs: null,
        finish_reason: mapCompletionFinishReason(response.finishReason)
      }],
      usage: {
        prompt_tokens: response.usage.promptTokens,
        completion_tokens: response.usage.completionTokens,
        total_tokens: response.usage.promptTokens + response.usage.completionTokens
      }
    }
  }

  serializeStreamChunk(chunk: LLMStreamChunk): any {
    const base = {
      id: this.completionId,
      object: 'text_completion',
      created: this.createdAt,
      model: 'llmhub'
    }

    if (chunk.type === 'done') {
      const result: any = {
        ...base,
        choices: [{
          text: '',
          index: 0,
          logprobs: null,
          finish_reason: mapCompletionFinishReason(chunk.finishReason)
        }]
      }
      if (chunk.usage) {
        result.usage = {
          prompt_tokens: chunk.usage.promptTokens,
          completion_tokens: chunk.usage.completionTokens,
          total_tokens: chunk.usage.promptTokens + chunk.usage.completionTokens
        }
      }
      return result
    }

    return {
      ...base,
      choices: [{
        text: chunk.type === 'content' ? (chunk.delta || '') : '',
        index: 0,
        logprobs: null,
        finish_reason: null
      }]
    }
  }
}
