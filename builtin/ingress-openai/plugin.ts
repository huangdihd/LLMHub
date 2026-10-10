import type { PluginAPI } from '../../server/plugins-runtime/manager'
import { ingress } from './ingress'
import { OpenAIChatParser } from './openai-chat'
import { OpenAIChatSerializer } from './openai-chat-serializer'
import { OpenAICompletionParser } from './openai-completion'
import { OpenAICompletionSerializer } from './openai-completion-serializer'
import { OpenAIResponsesParser } from './openai-responses'
import { OpenAIResponsesSerializer } from './openai-responses-serializer'

export default {
  setup(api: PluginAPI) {
    api.registerIngress(ingress)
    api.registerProtocol({
      id: 'openai-chat',
      createParser: () => new OpenAIChatParser(),
      createSerializer: () => new OpenAIChatSerializer()
    })
    api.registerProtocol({
      id: 'openai-completion',
      createParser: () => new OpenAICompletionParser(),
      createSerializer: () => new OpenAICompletionSerializer()
    })
    api.registerProtocol({
      id: 'openai-responses',
      createParser: () => new OpenAIResponsesParser(),
      createSerializer: () => new OpenAIResponsesSerializer()
    })
  }
}
