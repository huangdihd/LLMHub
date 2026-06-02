import type { ProtocolParser, LLMRequest, LLMStreamChunk, ContentBlock } from '../core/types'

export class OpenAIResponsesParser implements ProtocolParser {
  name = 'openai-responses'

  canHandle(url: string, method: string, body: any): boolean {
    return url.includes('/v1/responses') && method === 'POST'
  }

  parseRequest(body: any): LLMRequest {
    const input = body.input || []
    let systemPrompt: string | undefined
    const parsedMessages: any[] = []

    if (typeof input === 'string') {
      parsedMessages.push({ role: 'user', content: input })
    } else if (Array.isArray(input)) {
      for (const item of input) {
        if (item.role === 'system') {
          systemPrompt = typeof item.content === 'string' ? item.content : item.content?.map((c: any) => c.text || '').join('')
        } else {
          parsedMessages.push({
            role: item.role,
            content: this.parseContent(item.content)
          })
        }
      }
    }

    if (body.instructions) {
      systemPrompt = body.instructions
    }

    return {
      model: body.model,
      messages: parsedMessages,
      config: {
        maxTokens: body.max_output_tokens || 4096,
        temperature: body.temperature,
        stop: body.stop,
        systemPrompt
      },
      tools: body.tools?.filter((t: any) => t.type === 'function').map((t: any) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters
      })),
      stream: body.stream
    }
  }

  private parseContent(content: any): string | ContentBlock[] {
    if (typeof content === 'string') {
      return content
    }

    if (Array.isArray(content)) {
      return content.map((part: any) => {
        if (part.type === 'input_text') {
          return { type: 'text' as const, text: part.text }
        }
        if (part.type === 'image_url') {
          return { type: 'image' as const, imageUrl: part.image_url.url }
        }
        return { type: 'text' as const, text: '' }
      })
    }

    return ''
  }

  parseStreamChunk(chunk: any): LLMStreamChunk {
    if (chunk.type === 'response.completed') {
      return { type: 'done' }
    }

    if (chunk.type === 'response.output_text.delta') {
      return { type: 'content', delta: chunk.delta || '' }
    }

    if (chunk.type === 'response.function_call_arguments.delta') {
      return {
        type: 'tool_call',
        toolCall: {
          inputDelta: chunk.delta
        }
      }
    }

    if (chunk.type === 'response.output_item.done') {
      if (chunk.item?.type === 'function_call') {
        return {
          type: 'tool_call',
          toolCall: {
            id: chunk.item.call_id,
            name: chunk.item.name,
            inputDelta: chunk.item.arguments
          }
        }
      }
    }

    return { type: 'content', delta: '' }
  }
}
