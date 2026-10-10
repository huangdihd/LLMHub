export default {
  setup(api) {
    api.registerHook({
      id: 'append-system',
      onRequest(request) {
        if (!api.config.enabled) return
        return {
          ...request,
          config: { ...request.config, systemPrompt: [request.config.systemPrompt, api.config.suffix].filter(Boolean).join('\n') }
        }
      }
    })
    api.registerRoute('GET', 'status', () => ({ enabled: api.config.enabled }))
  }
}
