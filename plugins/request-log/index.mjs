/** @typedef {import('../../examples/plugins/llmhub-plugin').PluginAPI} PluginAPI */

const STORAGE_KEY = 'entries'
const MAX_LIMIT = 5000

/**
 * The gateway reports upstream failures in more than one shape; find the
 * human-readable message in whichever one this is.
 */
export function errorMessage(error) {
  if (!error) return ''
  const nested = value => (value && typeof value === 'object' ? value.error?.message || value.message : undefined)
  let text = nested(error.data) || nested(error._errorBody)
  if (!text && typeof error.message === 'string' && error.message.startsWith('{')) {
    try { text = nested(JSON.parse(error.message)) } catch {}
  }
  return String(text || error.message || error.statusMessage || (typeof error === 'string' ? error : 'Unknown error'))
}

/** Only what is needed to recognise a request. Never prompts, responses or credentials. */
export function toEntry({ completion, context }, now = Date.now()) {
  const usage = completion.usage
  const error = completion.error
  return {
    time: now,
    model: completion.model || '',
    provider: context.providerName || '',
    protocol: context.incomingProtocol || '',
    key: context.apiKeyRecord?.name || '',
    inputTokens: usage?.promptTokens ?? null,
    outputTokens: usage?.completionTokens ?? null,
    cachedTokens: usage?.cachedTokens ?? null,
    error: errorMessage(error).slice(0, 300)
  }
}

export default {
  /** @param {PluginAPI} api */
  async setup(api) {
    const limit = () => Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(api.config.limit) || 200)))
    /** @type {ReturnType<typeof toEntry>[]} newest last */
    let entries = (await api.storage.getItem(STORAGE_KEY)) || []
    let saving = Promise.resolve()
    // One write at a time; a failed write must not stop later ones.
    const save = () => { saving = saving.then(() => api.storage.setItem(STORAGE_KEY, entries)).catch(error => api.logger.warn('Could not save the request log', error)) }

    api.onEvent('llmhub:request-complete', payload => {
      entries.push(toEntry(payload))
      if (entries.length > limit()) entries = entries.slice(-limit())
      save()
    })
    api.onConfigChange(() => {
      if (entries.length > limit()) { entries = entries.slice(-limit()); save() }
    })

    api.registerMetric('today', () => {
      const midnight = new Date().setHours(0, 0, 0, 0)
      return entries.filter(entry => entry.time >= midnight).length
    })
    api.registerRoute('GET', 'entries', () => ({ entries: [...entries].reverse(), limit: limit() }))
    api.registerRoute('DELETE', 'entries', () => { entries = []; save(); return { cleared: true } })

    return () => saving
  }
}
