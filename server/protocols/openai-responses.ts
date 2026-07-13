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

    // call_id → tool name, so tool results keep their name (Gemini needs it)
    const toolNameById: Record<string, string> = {}

    const appendToolCall = (item: any) => {
      const call = {
        id: item.call_id || item.id,
        name: item.name,
        input: safeParseResponses(item.arguments || '{}')
      }
      if (call.id && call.name) toolNameById[call.id] = call.name
      const last = parsedMessages[parsedMessages.length - 1]
      if (last && last.role === 'assistant' && last.meta?.toolCalls) {
        last.meta.toolCalls.push(call)
      } else {
        parsedMessages.push({ role: 'assistant', content: '', meta: { toolCalls: [call] } })
      }
    }

    if (typeof input === 'string') {
      parsedMessages.push({ role: 'user', content: input })
    } else if (Array.isArray(input)) {
      for (const item of input) {
        if (item.type === 'function_call') {
          appendToolCall(item)
          continue
        }
        if (item.type === 'function_call_output') {
          parsedMessages.push({
            role: 'tool',
            content: typeof item.output === 'string' ? item.output : this.flattenText(item.output),
            meta: { toolCallId: item.call_id, name: toolNameById[item.call_id] }
          })
          continue
        }
        // Reasoning items from previous turns carry no replayable content for other providers
        if (item.type && item.type !== 'message') continue

        if (item.role === 'system' || item.role === 'developer') {
          const text = typeof item.content === 'string' ? item.content : this.flattenText(item.content)
          systemPrompt = systemPrompt ? `${systemPrompt}\n${text}` : text
        } else {
          parsedMessages.push({
            role: item.role === 'assistant' ? 'assistant' : 'user',
            content: this.parseContent(item.content)
          })
        }
      }
    }

    if (body.instructions) {
      systemPrompt = systemPrompt ? `${body.instructions}\n${systemPrompt}` : body.instructions
    }

    return {
      model: body.model,
      messages: parsedMessages,
      config: {
        maxTokens: body.max_output_tokens ?? undefined,
        temperature: body.temperature,
        topP: body.top_p,
        stop: body.stop,
        systemPrompt,
        // Responses API 用 top_logprobs 表达需求（并需在 include 里带
        // "message.output_text.logprobs"，此处宽松处理：给了 top_logprobs 即视为需要）
        topLogprobs: body.top_logprobs ?? undefined,
        logprobs: body.top_logprobs != null || body.logprobs === true ? true : undefined
      },
      tools: body.tools?.filter((t: any) => t.type === 'function').map((t: any) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters
      })),
      toolChoice: this.parseToolChoice(body.tool_choice),
      stream: body.stream
    }
  }

  private flattenText(content: any): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content.map((c: any) => c.text || '').join('')
  }

  private parseToolChoice(toolChoice: any): any {
    if (!toolChoice) return undefined
    if (typeof toolChoice === 'string') return toolChoice
    if (toolChoice.type === 'function') {
      return { name: toolChoice.name }
    }
    return 'auto'
  }

  private parseContent(content: any): string | ContentBlock[] {
    if (typeof content === 'string') {
      return content
    }

    if (Array.isArray(content)) {
      return content.map((part: any) => {
        if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
          return { type: 'text' as const, text: part.text || '' }
        }
        if (part.type === 'refusal') {
          return { type: 'text' as const, text: part.refusal || '' }
        }
        if (part.type === 'input_image' || part.type === 'image_url') {
          // Responses API uses a plain string image_url; tolerate the chat-style object too
          const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
          if (url) {
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
            return { type: 'image' as const, imageUrl: url }
          }
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

function safeParseResponses(str: string): object {
  try {
    return JSON.parse(str)
  } catch {
    return {}
  }
}
