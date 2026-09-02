import type { ProtocolParser, LLMRequest, LLMStreamChunk, ContentBlock } from '../core/types'

export class ClaudeMessagesParser implements ProtocolParser {
  name = 'claude-messages'

  canHandle(url: string, method: string, body: any): boolean {
    return url.includes('/v1/messages') && method === 'POST'
  }

  parseRequest(body: any): LLMRequest {
    const messages = body.messages || []
    let systemPrompt: string | undefined

    if (body.system) {
      systemPrompt = typeof body.system === 'string' ? body.system : body.system.map((s: any) => s.text || '').join('')
    }

    const parsedMessages = messages.map((msg: any) => ({
      role: msg.role,
      content: this.parseContent(msg.content),
      meta: this.parseMeta(msg.content)
    }))

    return {
      model: body.model,
      messages: parsedMessages,
      config: {
        maxTokens: body.max_tokens ?? undefined,
        temperature: body.temperature,
        topP: body.top_p,
        stop: body.stop_sequences,
        systemPrompt,
        thinking: body.thinking ? {
          enabled: body.thinking.type !== 'disabled',
          mode: body.thinking.type === 'adaptive' ? 'adaptive' : 'enabled',
          budgetTokens: body.thinking.budget_tokens,
          effort: body.output_config?.effort,
          includeSummary: true
        } : (body.output_config?.effort ? { enabled: true, effort: body.output_config.effort, includeSummary: true } : undefined)
      },
      tools: body.tools?.map((t: any) => ({
        name: t.name,
        description: t.description,
        parameters: t.input_schema
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
          return { type: 'text' as const, text: part.text || '' }
        }
        if (part.type === 'image') {
          if (part.source?.type === 'url') {
            return { type: 'image' as const, imageUrl: part.source.url }
          }
          if (part.source?.type === 'base64') {
            return {
              type: 'image' as const,
              imageBase64: part.source.data,
              imageMediaType: part.source.media_type
            }
          }
        }
        if (part.type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            toolUse: {
              id: part.id,
              name: part.name,
              input: part.input
            }
          }
        }
        if (part.type === 'tool_result') {
          return {
            type: 'tool_result' as const,
            toolResult: {
              toolUseId: part.tool_use_id,
              content: this.parseContent(part.content),
              isError: part.is_error
            }
          }
        }
        if (part.type === 'thinking') {
          return {
            type: 'thinking' as const,
            thinking: part.thinking,
            ...(part.signature ? { signature: part.signature } : {}),
            ...(part.signature ? { reasoningProvider: 'anthropic' as const } : {})
          }
        }
        if (part.type === 'redacted_thinking') {
          return {
            type: 'redacted_thinking' as const,
            data: part.data ?? part.signature,
            reasoningProvider: 'anthropic' as const
          }
        }
        // Skip unknown block types silently
        return { type: 'text' as const, text: '' }
      })
    }

    return ''
  }

  private parseMeta(content: any): any {
    if (!Array.isArray(content)) return undefined

    const toolUseBlocks = content.filter((p: any) => p.type === 'tool_use')
    if (toolUseBlocks.length > 0) {
      return {
        toolCalls: toolUseBlocks.map((t: any) => ({
          id: t.id,
          name: t.name,
          input: t.input
        }))
      }
    }

    const toolResult = content.find((p: any) => p.type === 'tool_result')
    if (toolResult) {
      return { toolCallId: toolResult.tool_use_id }
    }

    return undefined
  }

  private parseToolChoice(toolChoice: any): any {
    if (!toolChoice) return undefined
    if (toolChoice.type === 'auto') return 'auto'
    if (toolChoice.type === 'any') return 'required'
    if (toolChoice.type === 'tool') return { name: toolChoice.name }
    return 'auto'
  }

  parseStreamChunk(chunk: any): LLMStreamChunk {
    if (chunk.type === 'message_stop') {
      return { type: 'done' }
    }

    if (chunk.type === 'content_block_delta') {
      if (chunk.delta?.type === 'text_delta') {
        return { type: 'content', delta: chunk.delta.text }
      }
      if (chunk.delta?.type === 'input_json_delta') {
        return {
          type: 'tool_call',
          toolCall: { index: chunk.index, inputDelta: chunk.delta.partial_json }
        }
      }
    }

    if (chunk.type === 'content_block_start') {
      if (chunk.content_block?.type === 'tool_use') {
        return {
          type: 'tool_call',
          toolCall: {
            index: chunk.index,
            id: chunk.content_block.id,
            name: chunk.content_block.name
          }
        }
      }
    }

    if (chunk.type === 'message_delta') {
      if (chunk.delta?.stop_reason) {
        return {
          type: 'done',
          finishReason: chunk.delta.stop_reason === 'tool_use' ? 'tool_calls' : 'stop'
        }
      }
    }

    return { type: 'content', delta: '' }
  }
}
