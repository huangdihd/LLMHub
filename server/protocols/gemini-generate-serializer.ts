import type { ProtocolSerializer, LLMResponse, LLMStreamChunk } from '../core/types'

function safeParseArgs(str: string | undefined): object {
  if (!str) return {}
  try {
    return JSON.parse(str)
  } catch {
    return {}
  }
}

export class GeminiGenerateSerializer implements ProtocolSerializer {
  name = 'gemini-generate'

  // OpenAI/Claude upstreams stream tool arguments in fragments, but the Gemini
  // wire format only carries complete functionCall args. Buffer fragments per
  // call and flush them as whole parts in the final (done) chunk.
  private pendingTools: { id?: string; name?: string; args: string; thoughtSignature?: string }[] = []

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
        const fc: any = {
          id: tc.id,
          name: tc.name,
          args: typeof tc.input === 'string' ? safeParseArgs(tc.input) : (tc.input || {})
        }
        const part: any = { functionCall: fc }
        if (tc.thoughtSignature) part.thought_signature = tc.thoughtSignature
        parts.push(part)
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

  /** Returns null for chunks that are buffered (partial tool args) — skip writing those. */
  serializeStreamChunk(chunk: LLMStreamChunk): any | null {
    if (chunk.type === 'done') {
      const parts = this.pendingTools.map(t => {
        const part: any = {
          functionCall: {
            id: t.id,
            name: t.name,
            args: safeParseArgs(t.args)
          }
        }
        if (t.thoughtSignature) part.thought_signature = t.thoughtSignature
        return part
      })
      this.pendingTools = []

      const finishReason = this.mapFinishReason(chunk.finishReason || 'stop')
      return {
        candidates: [{
          content: { role: 'model', parts },
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

    if (chunk.type === 'content' || chunk.type === 'thinking') {
      if (!chunk.delta) return null
      return {
        candidates: [{
          content: {
            role: 'model',
            parts: [chunk.type === 'thinking' ? { text: chunk.delta, thought: true } : { text: chunk.delta }]
          },
          index: 0
        }]
      }
    }

    if (chunk.type === 'tool_call' && chunk.toolCall) {
      const tc = chunk.toolCall
      // A chunk carrying an id starts a new call; delta-only chunks append to the last one
      if (tc.id || this.pendingTools.length === 0) {
        this.pendingTools.push({
          id: tc.id,
          name: tc.name,
          args: tc.inputDelta || '',
          thoughtSignature: tc.thoughtSignature
        })
      } else {
        const current = this.pendingTools[this.pendingTools.length - 1]
        if (tc.name && !current.name) current.name = tc.name
        current.args += tc.inputDelta || ''
      }
      return null
    }

    return null
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
