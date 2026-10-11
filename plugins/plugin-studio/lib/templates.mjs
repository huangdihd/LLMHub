/** Starting points for a new plugin. Each returns `{ path: content }`. */

const manifest = (id, name, description, llmhub) => JSON.stringify({
  name: `llmhub-plugin-${id}`,
  version: '0.1.0',
  description,
  type: 'module',
  main: 'index.mjs',
  keywords: ['llmhub-plugin'],
  engines: { llmhub: '^1.4.0' },
  llmhub: { id, name, ...llmhub }
}, null, 2) + '\n'

const readme = (name, description) => `# ${name}\n\n${description}\n`

export const TEMPLATES = {
  hook: {
    label: 'Request hook',
    description: 'Changes requests on their way to the model',
    files: (id, name) => ({
      'package.json': manifest(id, name, 'Adds a note to every request.', {
        configSchema: [{ key: 'note', label: 'Note added to the system prompt', type: 'text', multiline: true, default: '' }]
      }),
      'index.mjs': `/** @typedef {import('./llmhub-plugin').PluginAPI} PluginAPI */

export default {
  /** @param {PluginAPI} api */
  setup(api) {
    api.registerHook({
      id: 'note',
      onRequest(request) {
        const note = String(api.config.note || '').trim()
        if (!note) return
        const systemPrompt = [note, request.config.systemPrompt].filter(Boolean).join('\\n\\n')
        return { ...request, config: { ...request.config, systemPrompt } }
      }
    })
  }
}
`,
      'README.md': readme(name, 'Adds a note to the system prompt of every request.')
    })
  },
  panel: {
    label: 'Page with a route',
    description: 'A dashboard page backed by a management route',
    files: (id, name) => ({
      'package.json': manifest(id, name, 'Counts finished requests and shows them on a page.', {
        contributes: {
          metrics: [{ key: 'count', label: 'Requests counted', icon: 'i-heroicons-bolt' }],
          panels: [{ id: 'main', title: name, location: 'page', page: 'ui/index.html' }],
          navigation: [{ panel: 'main', label: name }]
        }
      }),
      'index.mjs': `/** @typedef {import('./llmhub-plugin').PluginAPI} PluginAPI */

export default {
  /** @param {PluginAPI} api */
  async setup(api) {
    let count = (await api.storage.getItem('count')) || 0
    api.onEvent('llmhub:request-complete', () => {
      count += 1
      api.storage.setItem('count', count).catch(error => api.logger.warn('Could not save', error))
    })
    api.registerMetric('count', () => count)
    api.registerRoute('GET', 'count', () => ({ count }))
    api.registerRoute('DELETE', 'count', async () => {
      count = 0
      await api.storage.setItem('count', count)
      return { count }
    })
  }
}
`,
      'ui/index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    :root { color-scheme: light; --text: #111827; --muted: #6b7280; --card: #fff; --line: #e5e7eb; }
    :root[data-theme="dark"] { color-scheme: dark; --text: #fff; --muted: #9ca3af; --card: #111827; --line: #1f2937; }
    body { margin: 0; font: 14px/1.5 system-ui, sans-serif; color: var(--text); background: transparent; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 20px; }
    .value { font-size: 32px; font-weight: 600; }
    p { color: var(--muted); margin: 0 0 12px; }
  </style>
</head>
<body>
  <div class="card">
    <p>Requests counted since this plugin was enabled</p>
    <div class="value" id="count">…</div>
    <button id="reset" type="button">Reset</button>
  </div>
  <script>
    const show = data => { document.getElementById('count').textContent = data.count.toLocaleString() }
    const load = () => llmhub.fetch('count').then(show)
    document.getElementById('reset').addEventListener('click', () => llmhub.fetch('count', { method: 'DELETE' }).then(show))
    load()
    setInterval(load, 5000)
  </script>
</body>
</html>
`,
      'README.md': readme(name, 'Counts finished requests, shows the count on a page and on the home page.')
    })
  },
  empty: {
    label: 'Empty',
    description: 'Just a manifest and an entry file',
    files: (id, name) => ({
      'package.json': manifest(id, name, '', {}),
      'index.mjs': `/** @typedef {import('./llmhub-plugin').PluginAPI} PluginAPI */

export default {
  /** @param {PluginAPI} api */
  setup(api) {
    api.logger.info('Started')
  }
}
`
    })
  }
}
