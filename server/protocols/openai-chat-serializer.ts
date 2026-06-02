import type { ProtocolSerializer, LLMResponse, LLMStreamChunk } from '../core/types'

export class OpenAIChatSerializer implements ProtocolSerializer {
  name = 'openai-chat'

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

    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'llmhub',
      choices: [{
        index: 0,
        message,
        finish_reason: response.finishReason === 'tool_calls' ? 'tool_calls' : 'stop'
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
      return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'llmhub',
        choices: [{
          index: 0,
          delta: {},
          finish_reason: chunk.finishReason === 'tool_calls' ? 'tool_calls' : 'stop'
        }]
      }
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
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'llmhub',
      choices: [{
        index: 0,
        delta,
        finish_reason: null
      }]
    }
  }
}
