import type { ProtocolSerializer, LLMResponse, LLMStreamChunk } from '../core/types'

export class GeminiGenerateSerializer implements ProtocolSerializer {
  name = 'gemini-generate'

  serializeResponse(response: LLMResponse): any {
    const parts: any[] = []

    if (typeof response.content === 'string') {
      if (response.content) {
        parts.push({ text: response.content })
      }
    } else {
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          parts.push({ text: block.text })
        } else if (block.type === 'thinking' && block.thinking) {
          parts.push({ text: block.thinking, thought: true })
        }
      }
    }

    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const tc of response.toolCalls) {
        parts.push({
          functionCall: {
            id: tc.id,
            name: tc.name,
            args: typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input
          }
        })
      }
    }

    const finishReason = this.mapFinishReason(response.finishReason)

    return {
      candidates: [{
        content: {
          role: 'model',
          parts
        },
        finishReason,
        index: 0
      }],
      usageMetadata: {
        promptTokenCount: response.usage.promptTokens,
        candidatesTokenCount: response.usage.completionTokens,
        totalTokenCount: response.usage.promptTokens + response.usage.completionTokens
      },
      modelVersion: 'llmhub'
    }
  }

  serializeStreamChunk(chunk: LLMStreamChunk): any {
    if (chunk.type === 'done') {
      const finishReason = this.mapFinishReason(chunk.finishReason || 'stop')
      return {
        candidates: [{
          content: { role: 'model', parts: [] },
          finishReason,
          index: 0
        }],
        usageMetadata: chunk.usage ? {
          promptTokenCount: chunk.usage.promptTokens,
          candidatesTokenCount: chunk.usage.completionTokens,
          totalTokenCount: chunk.usage.promptTokens + chunk.usage.completionTokens
        } : undefined
      }
    }

    if (chunk.type === 'content') {
      return {
        candidates: [{
          content: {
            role: 'model',
            parts: [{ text: chunk.delta || '' }]
          },
          index: 0
        }]
      }
    }

    if (chunk.type === 'thinking') {
      return {
        candidates: [{
          content: {
            role: 'model',
            parts: [{ text: chunk.delta || '', thought: true }]
          },
          index: 0
        }]
      }
    }

    if (chunk.type === 'tool_call' && chunk.toolCall) {
      return {
        candidates: [{
          content: {
            role: 'model',
            parts: [{
              functionCall: {
                id: chunk.toolCall.id,
                name: chunk.toolCall.name,
                args: chunk.toolCall.inputDelta
                  ? JSON.parse(chunk.toolCall.inputDelta)
                  : {}
              }
            }]
          },
          index: 0
        }]
      }
    }

    return {
      candidates: [{
        content: { role: 'model', parts: [] },
        index: 0
      }]
    }
  }

  private mapFinishReason(reason: string): string {
    switch (reason) {
      case 'stop': return 'STOP'
      case 'length': return 'MAX_TOKENS'
      case 'tool_calls': return 'STOP'
      case 'error': return 'OTHER'
      default: return reason || 'STOP'
    }
  }
}
