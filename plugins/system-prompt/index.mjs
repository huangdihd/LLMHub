/** @typedef {import('../../examples/plugins/llmhub-plugin').PluginAPI} PluginAPI */

/** Joins the parts that are present, in order. */
export function compose(position, added, existing) {
  if (!added) return existing
  if (position === 'replace') return added
  const parts = position === 'after' ? [existing, added] : [added, existing]
  return parts.filter(Boolean).join('\n\n')
}

export default {
  /** @param {PluginAPI} api */
  setup(api) {
    api.registerHook({
      id: 'apply',
      async onRequest(request) {
        const perModel = request.model ? (await api.getRecordValues('models', request.model)).prompt : ''
        // The per-model prompt is more specific, so it goes closest to the conversation.
        const added = [api.config.prompt, perModel].filter(Boolean).join('\n\n')
        if (!added) return
        return {
          ...request,
          config: { ...request.config, systemPrompt: compose(api.config.position, added, request.config.systemPrompt) }
        }
      }
    })
  }
}
