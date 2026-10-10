export const manifest = {
  id: 'example-system-prompt', name: 'System Prompt', version: '1.0.0',
  engines: { llmhub: '^1.0.0' },
  description: 'Append a configured instruction to each generation request.',
  configSchema: [
    { key: 'suffix', label: 'System instruction', type: 'text', default: 'PLUGIN_INSTRUCTION' },
    { key: 'enabled', label: 'Append instruction', type: 'boolean', default: true },
    { key: 'token', label: 'Example secret', type: 'secret' }
  ]
}

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
