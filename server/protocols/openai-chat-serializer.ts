import type { ProtocolSerializer, LLMResponse, LLMStreamChunk } from '../core/types'

function mapChatFinishReason(reason: string | undefined): string {
  if (reason === 'tool_calls') return 'tool_calls'
  if (reason === 'length') return 'length'
  return 'stop'
}

export class OpenAIChatSerializer implements ProtocolSerializer {
  name = 'openai-chat'

  // One id shared by every chunk of a stream, as the OpenAI API does
  private chatId = `chatcmpl-${Date.now()}${Math.random().toString(36).slice(2, 8)}`
  private createdAt = Math.floor(Date.now() / 1000)

  serializeResponse(response: LLMResponse): any {
    const message: any = {
      role: 'assistant',
      content: null
    }

    if (typeof response.content === 'string') {
      message.content = response.content
    } else {
      for (const block of response.content) {
        if (block.type === 'text') {
          message.content = (message.content || '') + block.text
        } else if (block.type === 'thinking') {
          message.reasoning_content = (message.reasoning_content || '') + block.thinking
        }
      }
    }

    if (response.toolCalls && response.toolCalls.length > 0) {
      message.tool_calls = response.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.input)
        }
      }))
      message.content = message.content || null
    }

    // Ensure assistant message always has content or tool_calls
    if (message.content === null && !message.tool_calls) {
      message.content = ''
    }

    return {
      id: this.chatId,
      object: 'chat.completion',
      created: this.createdAt,
      model: 'llmhub',
      choices: [{
        index: 0,
        message,
        finish_reason: mapChatFinishReason(response.finishReason)
      }],
      usage: {
        prompt_tokens: response.usage.promptTokens,
        completion_tokens: response.usage.completionTokens,
        total_tokens: response.usage.promptTokens + response.usage.completionTokens
      }
    }
  }

  serializeStreamChunk(chunk: LLMStreamChunk): any {
    if (chunk.type === 'done') {
      const result: any = {
        id: this.chatId,
        object: 'chat.completion.chunk',
        created: this.createdAt,
        model: 'llmhub',
        choices: [{
          index: 0,
          delta: {},
          finish_reason: mapChatFinishReason(chunk.finishReason)
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

    const delta: any = {}
    if (chunk.type === 'content') {
      delta.content = chunk.delta
    }
    if (chunk.type === 'thinking') {
      delta.reasoning_content = chunk.delta
    }
    if (chunk.type === 'tool_call' && chunk.toolCall) {
      const toolCallObj: any = {
        index: chunk.toolCall.index ?? 0,
      }
      
      if (chunk.toolCall.id !== undefined) {
        toolCallObj.id = chunk.toolCall.id
        toolCallObj.type = 'function'
      }
      
      toolCallObj.function = {}
      if (chunk.toolCall.name !== undefined) {
        toolCallObj.function.name = chunk.toolCall.name
      }
      if (chunk.toolCall.inputDelta !== undefined) {
        toolCallObj.function.arguments = chunk.toolCall.inputDelta
      } else {
        toolCallObj.function.arguments = ''
      }

      delta.tool_calls = [toolCallObj]
    }

    return {
      id: this.chatId,
      object: 'chat.completion.chunk',
      created: this.createdAt,
      model: 'llmhub',
      choices: [{
        index: 0,
        delta,
        finish_reason: null
      }]
    }
  }
}
