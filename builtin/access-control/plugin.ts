import type { PluginAPI } from '../../server/plugins-runtime/manager'

export default {
  setup(api: PluginAPI) {
    api.registerHook({
      id: 'permissions', priority: -200,
      onModelResolved(context) {
        const record = context.apiKeyRecord!
        const model = context.model
        const hasProvider = record.allowed_providers?.length > 0
        const hasModel = record.allowed_models?.length > 0
        if (!hasProvider && !hasModel) return
        if (hasModel && record.allowed_models.includes(model)) return
        if (hasProvider) {
          const slash = model.indexOf('/')
          if (slash > 0 && record.allowed_providers.includes(model.slice(0, slash))) return
        }
        return { status: 403, message: `Model "${model}" is not allowed for this API key.`, code: 'access_denied' }
      },
      onModels(models, context) {
        const record = context.apiKeyRecord
        if (!record) return
        const hasModels = record.allowed_models?.length > 0
        const hasProviders = record.allowed_providers?.length > 0
        if (!hasModels && !hasProviders) return
        return models.filter(model => (hasModels && record.allowed_models.includes(model.id))
          || (hasProviders && record.allowed_providers.includes(model.provider)))
      }
    })
  }
}
