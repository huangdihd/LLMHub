export default {
  /** @param {import('../llmhub-plugin.js').PluginAPI} api */
  setup(api) {
    // Read the current configuration on every call, not a setup-time snapshot.
    api.provide({
      /** @param {string} value */
      format(value) { return `${String(api.config.prefix ?? '')}${value}` }
    })

    // Await delivery so callers can inspect the consumer immediately afterwards.
    api.registerRoute('POST', 'announce', async () => {
      const message = `${String(api.config.prefix ?? '')}Hello from an event`
      await api.emitEvent('message', { message })
      return { message }
    })
  }
}
