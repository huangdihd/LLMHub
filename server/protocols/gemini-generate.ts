import type { ProtocolParser, LLMRequest, LLMStreamChunk, ContentBlock } from '../core/types'
import { sanitizeGeminiSchema } from '../utils/sanitize-gemini-schema'

export class GeminiGenerateParser implements ProtocolParser {
  name = 'gemini-generate'

  canHandle(url: string, method: string, _body: any): boolean {
    return method === 'POST' && /\/models\/[^/]+:(generateContent|streamGenerateContent)/.test(url)
  }

  parseRequest(body: any, modelFromUrl?: string): LLMRequest {
    const contents = body.contents || []
    let systemPrompt: string | undefined
    const parsedMessages: any[] = []

    if (body.systemInstruction) {
      systemPrompt = this.extractText(body.systemInstruction)
    }

    // functionResponse carries no id in the Gemini protocol (matching is by
    // name/order) — remember the ids we minted for functionCalls so the
    // result can reference the same id on id-based upstreams
    const lastCallIdByName: Record<string, string> = {}

    for (const content of contents) {
      const role = content.role === 'model' ? 'assistant' : (content.role || 'user')
      const parts = content.parts || []
      const contentBlocks: ContentBlock[] = []
      const toolCalls: any[] = []
      let toolCallId: string | undefined
      let toolCallName: string | undefined

      for (const part of parts) {
        if (part.text) {
          if (part.thought === true) {
            contentBlocks.push({ type: 'thinking', thinking: part.text })
          } else {
            contentBlocks.push({ type: 'text', text: part.text })
          }
        }
        if (part.inlineData) {
          contentBlocks.push({
            type: 'image',
            imageBase64: part.inlineData.data,
            imageMediaType: part.inlineData.mimeType
          })
        }
        if (part.fileData) {
          contentBlocks.push({
            type: 'image',
            imageUrl: part.fileData.fileUri,
            imageMediaType: part.fileData.mimeType
          })
        }
        if (part.functionCall) {
          const call = {
            id: part.functionCall.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: part.functionCall.name,
            input: part.functionCall.args || {}
          }
          if (call.name) lastCallIdByName[call.name] = call.id
          toolCalls.push(call)
        }
        if (part.functionResponse) {
          toolCallName = part.functionResponse.name
          toolCallId = part.functionResponse.id
            || (toolCallName ? lastCallIdByName[toolCallName] : undefined)
          const resp = part.functionResponse.response
          if (resp) {
            const output = resp.output || resp.error || JSON.stringify(resp)
            contentBlocks.push({ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) })
          }
        }
      }

      parsedMessages.push({
        // Tool results flow through the adapters' unified 'tool' role path
        role: toolCallId ? 'tool' : role,
        content: contentBlocks.length > 0 ? contentBlocks : '',
        meta: {
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          toolCallId,
          name: toolCallName
        }
      })
    }

    const genConfig = body.generationConfig || {}
    const thinkConfig = body.thinkingConfig || genConfig.thinkingConfig || {}
    const modelId = modelFromUrl || body.model

    const thinkingConfig = Object.keys(thinkConfig).length > 0 ? {
      thinkingBudget: thinkConfig.thinkingBudget ?? (thinkConfig.thinkingLevel ? 8192 : undefined),
      includeThoughts: thinkConfig.includeThoughts
    } : undefined

    return {
      model: modelId,
      messages: parsedMessages,
      config: {
        maxTokens: genConfig.maxOutputTokens ?? undefined,
        temperature: genConfig.temperature,
        topP: genConfig.topP,
        stop: genConfig.stopSequences,
        systemPrompt,
        thinkingConfig
      },
      tools: this.extractTools(body.tools),
      stream: false
    }
  }

  private extractText(instruction: any): string {
    if (typeof instruction === 'string') return instruction
    if (instruction.parts) {
      return instruction.parts.map((p: any) => p.text || '').join('')
    }
    return ''
  }

  private extractTools(tools: any[] | undefined): any[] | undefined {
    if (!tools?.length) return undefined
    const result: any[] = []
    for (const tool of tools) {
      if (tool.functionDeclarations) {
        for (const fd of tool.functionDeclarations) {
          result.push({
            name: fd.name,
            description: fd.description,
            parameters: sanitizeGeminiSchema(fd.parameters || {})
          })
        }
      }
    }
    return result.length > 0 ? result : undefined
  }

  parseStreamChunk(chunk: any): LLMStreamChunk {
    const candidate = chunk.candidates?.[0]
    if (!candidate) {
      return { type: 'content', delta: '' }
    }

    if (candidate.finishReason) {
      return { type: 'done', finishReason: 'stop' }
    }

    const parts = candidate.content?.parts || []
    if (parts.length > 0) {
      const part = parts[0]
      if (part.text) return { type: 'content', delta: part.text }
      if (part.functionCall) {
        return {
          type: 'tool_call',
          toolCall: {
            index: 0,
            id: part.functionCall.id,
            name: part.functionCall.name,
            inputDelta: JSON.stringify(part.functionCall.args || {}),
            thoughtSignature: part.thoughtSignature || ''
          }
        }
      }
    }

    return { type: 'content', delta: '' }
  }
}
