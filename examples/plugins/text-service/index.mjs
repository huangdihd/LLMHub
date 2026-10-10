export default {
  /** @param {import('../llmhub-plugin.js').PluginAPI} api */
  setup(api) {
    // Read the current configuration on every call, not a setup-time snapshot.
    api.provide({
      /** @param {string} value */
      format(value) { return `${String(api.config.prefix ?? '')}${value}` }
    })
  }
}
