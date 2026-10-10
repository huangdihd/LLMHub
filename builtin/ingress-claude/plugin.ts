import type { PluginAPI } from '../../server/plugins-runtime/manager'
import { ingress } from './ingress'
import { ClaudeMessagesParser } from './claude-messages'
import { ClaudeMessagesSerializer } from './claude-messages-serializer'
import { ClaudeCompletionParser } from './claude-completion'
import { ClaudeCompletionSerializer } from './claude-completion-serializer'

export default {
  setup(api: PluginAPI) {
    api.registerIngress(ingress)
    api.registerProtocol({
      id: 'claude-messages',
      createParser: () => new ClaudeMessagesParser(),
      createSerializer: () => new ClaudeMessagesSerializer()
    })
    api.registerProtocol({
      id: 'claude-completion',
      createParser: () => new ClaudeCompletionParser(),
      createSerializer: () => new ClaudeCompletionSerializer()
    })
  }
}
