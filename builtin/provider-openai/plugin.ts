import type { PluginAPI } from '../../server/plugins-runtime/manager'
import { OpenAIAdapter } from './openai'
import { fetchOpenAIModels } from './model-discovery'
import { management } from './management'
import { OpenAIResponsesAdapter } from './openai-responses'

export default {
  setup(api: PluginAPI) {
    api.registerProvider({
      id: 'openai',
      management,
      createAdapter: config => config.connection.api_type === 'responses'
        ? new OpenAIResponsesAdapter(config)
        : new OpenAIAdapter(config),
      fetchModels: fetchOpenAIModels,
      secretConnectionFields: []
    })
  }
}
