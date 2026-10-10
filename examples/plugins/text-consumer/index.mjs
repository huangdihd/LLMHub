/** @typedef {{ format(value: string): string }} TextService */
/** @typedef {{ record(message: string): void }} AuditService */

export default {
  /** @param {import('../llmhub-plugin.js').PluginAPI} api */
  setup(api) {
    const text = /** @type {TextService | undefined} */ (api.require('example-text-service'))
    // A dependency can activate without publishing a service. Fail at setup,
    // rather than leaving a route that only discovers the problem on requests.
    if (!text || typeof text.format !== 'function') throw new Error('Text service must provide format(value)')

    api.registerRoute('GET', 'greeting', () => {
      const message = text.format('Hello from a dependent plugin')
      // Resolve optional services at use time: they may be unavailable.
      const audit = /** @type {AuditService | undefined} */ (api.require('example-audit-service'))
      if (audit) audit.record(message)
      return { message }
    })
  }
}
