import { ProtocolRegistry } from '../core/protocol-registry'
import { OpenAIChatParser } from './openai-chat'
import { OpenAICompletionParser } from './openai-completion'
import { OpenAIResponsesParser } from './openai-responses'
import { ClaudeMessagesParser } from './claude-messages'
import { ClaudeCompletionParser } from './claude-completion'
import { GeminiGenerateParser } from './gemini-generate'
import { OpenAIChatSerializer } from './openai-chat-serializer'
import { OpenAIResponsesSerializer } from './openai-responses-serializer'
import { OpenAICompletionSerializer } from './openai-completion-serializer'
import { ClaudeMessagesSerializer } from './claude-messages-serializer'
import { ClaudeCompletionSerializer } from './claude-completion-serializer'
import { GeminiGenerateSerializer } from './gemini-generate-serializer'

export function registerBuiltinProtocols(registry: ProtocolRegistry): void {
  registry.register({
    id: 'openai-chat',
    createParser: () => new OpenAIChatParser(),
    createSerializer: () => new OpenAIChatSerializer()
  })
  registry.register({
    id: 'openai-completion',
    createParser: () => new OpenAICompletionParser(),
    createSerializer: () => new OpenAICompletionSerializer()
  })
  registry.register({
    id: 'openai-responses',
    createParser: () => new OpenAIResponsesParser(),
    createSerializer: () => new OpenAIResponsesSerializer()
  })
  registry.register({
    id: 'claude-messages',
    createParser: () => new ClaudeMessagesParser(),
    createSerializer: () => new ClaudeMessagesSerializer()
  })
  registry.register({
    id: 'claude-completion',
    createParser: () => new ClaudeCompletionParser(),
    createSerializer: () => new ClaudeCompletionSerializer()
  })
  registry.register({
    id: 'gemini-generate',
    createParser: () => new GeminiGenerateParser(),
    createSerializer: () => new GeminiGenerateSerializer()
  })
}

export const protocolRegistry = new ProtocolRegistry()
registerBuiltinProtocols(protocolRegistry)
