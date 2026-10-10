import type { PluginAPI } from '../../server/plugins-runtime/manager'
import { getBillableTokens } from './service'

export default {
  setup(api: PluginAPI) {
    api.registerHook({
      id: 'billing', priority: -200,
      async onAccountingComplete(completion, context) {
        if (completion.kind !== 'usage' || !context.apiKeyRecord) return
        completion.tokens = typeof completion.usage === 'number'
          ? completion.usage : await getBillableTokens(completion.usage, completion.model)
      }
    })
  }
}
