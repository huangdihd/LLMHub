import type { ProtocolParser, LLMRequest, LLMStreamChunk, ContentBlock } from '../core/types'

export class OpenAIChatParser implements ProtocolParser {
  name = 'openai-chat'

  canHandle(url: string, method: string, body: any): boolean {
    return url.includes('/v1/chat/completions') && method === 'POST'
  }

  parseRequest(body: any): LLMRequest {
    const messages = body.messages || []
    let systemPrompt: string | undefined
    const parsedMessages: any[] = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = typeof msg.content === 'string' ? msg.content : msg.content.map((c: any) => c.text || '').join('')
      } else {
        let content = this.parseContent(msg.content)
        
        // Handle reasoning_content field (DeepSeek/OpenAI style thinking)
        if (msg.reasoning_content) {
          const blocks: ContentBlock[] = []
          blocks.push({ type: 'thinking', thinking: msg.reasoning_content })
          if (typeof content === 'string') {
            if (content) blocks.push({ type: 'text', text: content })
          } else {
            blocks.push(...content)
          }
          content = blocks
        }

        parsedMessages.push({
          role: msg.role,
          content,
          meta: {
            toolCalls: msg.tool_calls?.map((tc: any) => ({
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments || '{}')
            })),
            toolCallId: msg.tool_call_id
          }
        })
      }
    }

    return {
      model: body.model,
      messages: parsedMessages,
      config: {
        maxTokens: body.max_tokens || 4096,
        temperature: body.temperature,
        topP: body.top_p,
        stop: body.stop,
        systemPrompt
      },
      tools: body.tools?.map((t: any) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
      })),
      toolChoice: this.parseToolChoice(body.tool_choice),
      stream: body.stream
    }
  }

  private parseContent(content: any): string | ContentBlock[] {
    if (typeof content === 'string') {
      return content
    }

    if (Array.isArray(content)) {
      return content.map((part: any) => {
        if (part.type === 'text') {
          return { type: 'text' as const, text: part.text }
        }
        if (part.type === 'image_url') {
          const url = part.image_url.url
          if (url.startsWith('data:')) {
            const match = url.match(/^data:([^;]+);base64,(.+)$/)
            if (match) {
              return {
                type: 'image' as const,
                imageBase64: match[2],
                imageMediaType: match[1]
              }
            }
          }
          return {
            type: 'image' as const,
            imageUrl: url
          }
        }
        return { type: 'text' as const, text: '' }
      })
    }

    return ''
  }

  private parseToolChoice(toolChoice: any): any {
    if (!toolChoice) return undefined
    if (typeof toolChoice === 'string') return toolChoice
    if (toolChoice.type === 'function') {
      return { name: toolChoice.function.name }
    }
    return 'auto'
  }

  parseStreamChunk(chunk: any): LLMStreamChunk {
    const choice = chunk.choices?.[0]
    if (!choice) {
      return { type: 'done' }
    }

    if (choice.finish_reason) {
      return {
        type: 'done',
        finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop'
      }
    }

    const delta = choice.delta
    if (delta?.content) {
      return { type: 'content', delta: delta.content }
    }

    if (delta?.tool_calls) {
      const tc = delta.tool_calls[0]
      return {
        type: 'tool_call',
        toolCall: {
          index: tc.index,
          id: tc.id,
          name: tc.function?.name,
          inputDelta: tc.function?.arguments
        }
      }
    }

    return { type: 'content', delta: '' }
  }
}
