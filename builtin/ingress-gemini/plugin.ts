import type { PluginAPI } from '../../server/plugins-runtime/manager'
import { ingress } from './ingress'
import { GeminiGenerateParser } from './gemini-generate'
import { GeminiGenerateSerializer } from './gemini-generate-serializer'

export default {
  setup(api: PluginAPI) {
    api.registerIngress(ingress)
    api.registerProtocol({
      id: 'gemini-generate',
      createParser: () => new GeminiGenerateParser(),
      createSerializer: () => new GeminiGenerateSerializer()
    })
  }
}
