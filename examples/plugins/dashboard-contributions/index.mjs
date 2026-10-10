/** @type {import('../llmhub-plugin').PluginModule} */
export default {
  setup(api) {
    let requests = 0
    let lastChange = null
    api.registerHook({
      id: 'model-instruction',
      async onRequest(request) {
        requests++
        if (!request.model) return
        const values = await api.getRecordValues('models', request.model)
        if (!values.enabled || !values.instruction) return
        return {
          ...request,
          config: { ...request.config, systemPrompt: [request.config.systemPrompt, values.instruction].filter(Boolean).join('\n') }
        }
      }
    })
    api.onRecordValuesChange(change => { lastChange = change })
    api.registerMetric('requests', () => requests)
    // Never expose record values here: they can include secrets.
    api.registerRoute('GET', 'status', () => ({ requests, changed: lastChange !== null }))
  }
}
