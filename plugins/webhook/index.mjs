/** @typedef {import('../../examples/plugins/llmhub-plugin').PluginAPI} PluginAPI */

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

/** A short, credential-free description of a failed request. */
export function describe({ completion, context }, skipped = 0) {
  const error = completion.error
  const lines = [
    'LLMHub: a request failed',
    `Model: ${completion.model || 'unknown'}`,
    `Provider: ${context.providerName || 'unknown'}`,
    `API key: ${context.apiKeyRecord?.name || 'unknown'}`,
    `Error: ${errorMessage(error).slice(0, 500)}`
  ]
  if (skipped > 0) lines.push(`(${skipped} more failure${skipped === 1 ? '' : 's'} since the last alert)`)
  return lines.join('\n')
}

/** The request body each service expects for a plain text message. */
export function body(format, text, payload) {
  if (format === 'feishu') return { msg_type: 'text', content: { text } }
  if (format === 'dingtalk' || format === 'wecom') return { msgtype: 'text', text: { content: text } }
  return {
    event: 'request-failed', text,
    model: payload.completion.model || null,
    provider: payload.context.providerName || null,
    apiKey: payload.context.apiKeyRecord?.name || null
  }
}

export default {
  /** @param {PluginAPI} api */
  setup(api) {
    let lastSent = 0
    let skipped = 0

    api.onEvent('llmhub:request-complete', async payload => {
      if (!payload.completion.error) return
      const url = String(api.config.url || '')
      if (!/^https?:\/\//.test(url)) return
      const interval = Math.max(0, Number(api.config.interval) || 0) * 1000
      if (Date.now() - lastSent < interval) { skipped++; return }
      lastSent = Date.now()
      const text = describe(payload, skipped)
      skipped = 0
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body(api.config.format, text, payload)),
          signal: AbortSignal.timeout(4000)
        })
        // The URL holds the bot's token, so it is never logged.
        if (!response.ok) api.logger.warn(`The webhook answered with status ${response.status}`)
      } catch (error) {
        api.logger.warn('Could not reach the webhook:', error instanceof Error ? error.name : 'error')
      }
    })
  }
}
