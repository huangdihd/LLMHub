/** @type {import('./llmhub-plugin.js').PluginManifest} */
export const manifest = {
  id: 'example-text-service', name: 'Text Service', version: '1.0.0',
  engines: { llmhub: '^1.0.0' },
  description: 'Publish a small synchronous service for dependent plugins.',
  configSchema: [{ key: 'prefix', label: 'Text prefix', type: 'text', default: '[shared] ' }]
}

export default {
  /** @param {import('./llmhub-plugin.js').PluginAPI} api */
  setup(api) {
    // Read the current configuration on every call, not a setup-time snapshot.
    api.provide({
      /** @param {string} value */
      format(value) { return `${String(api.config.prefix ?? '')}${value}` }
    })
  }
}
