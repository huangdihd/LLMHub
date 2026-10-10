import { greet } from '@llmhub/example-greeting'

export default {
  /** @param {import('../llmhub-plugin.js').PluginAPI} api */
  setup(api) {
    api.provide({
      /** @param {string} name */
      greet(name) { return greet(String(api.config.prefix ?? ''), name) }
    })
    api.registerRoute('GET', 'status', () => ({ ready: true }))
  }
}
