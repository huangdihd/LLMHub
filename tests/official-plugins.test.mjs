import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugins')

/** A stand-in for the injected API that records what a plugin registers. */
function host(config = {}, records = {}) {
  const state = { hooks: [], events: new Map(), routes: new Map(), metrics: new Map(), storage: new Map(), warnings: [], configListeners: [] }
  const api = {
    config,
    registerHook: hook => state.hooks.push(hook),
    onEvent: (name, listener) => state.events.set(name, listener),
    registerRoute: (method, path, handler) => state.routes.set(`${method} ${path}`, handler),
    registerMetric: (key, getter) => state.metrics.set(key, getter),
    onConfigChange: listener => state.configListeners.push(listener),
    getRecordValues: async (location, id) => records[`${location}:${id}`] || {},
    storage: {
      getItem: async key => structuredClone(state.storage.get(key) ?? null),
      setItem: async (key, value) => { state.storage.set(key, structuredClone(value)) },
      removeItem: async key => { state.storage.delete(key) }
    },
    logger: { info() {}, warn: (...values) => state.warnings.push(values.join(' ')), error() {} }
  }
  return { api, state }
}
const load = name => import(join(root, name, 'index.mjs'))
const completed = (overrides = {}) => ({
  completion: { model: 'openai/gpt', usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 4 }, ...overrides },
  context: { incomingProtocol: 'openai-chat', providerName: 'openai', apiKeyRecord: { name: 'laptop', hash: 'secret-hash' }, providerConfig: { connection: { api_key: 'sk-secret' } } }
})

test('every official plugin is a publishable package that the market can find', () => {
  for (const name of readdirSync(root)) {
    const manifest = JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8'))
    assert.equal(manifest.name, `llmhub-plugin-${name}`)
    assert.ok(manifest.keywords.includes('llmhub-plugin'))
    assert.match(manifest.engines.llmhub, /^\^1\.\d+\.0$/)
    assert.ok(manifest.llmhub.name)
    for (const file of manifest.files) readdirSync(root + '/' + name).includes(file) || assert.fail(`${name}: missing ${file}`)
  }
})

test('system-prompt combines the global and per-model prompts in the chosen position', async () => {
  const { default: plugin, compose } = await load('system-prompt')
  assert.equal(compose('before', 'A', 'B'), 'A\n\nB')
  assert.equal(compose('after', 'A', 'B'), 'B\n\nA')
  assert.equal(compose('replace', 'A', 'B'), 'A')
  assert.equal(compose('before', '', 'B'), 'B')

  const { api, state } = host({ prompt: 'Global', position: 'before' }, { 'models:openai/gpt': { prompt: 'For this model' } })
  plugin.setup(api)
  const request = { model: 'openai/gpt', messages: [], config: { systemPrompt: 'Client' } }
  const result = await state.hooks[0].onRequest(request)
  assert.equal(result.config.systemPrompt, 'Global\n\nFor this model\n\nClient')
  assert.equal(request.config.systemPrompt, 'Client', 'the incoming request is not mutated')

  const idle = host({ prompt: '', position: 'before' })
  plugin.setup(idle.api)
  assert.equal(await idle.state.hooks[0].onRequest(request), undefined)
})

test('request-log records metadata only, trims to the limit and survives a restart', async () => {
  const { default: plugin, toEntry } = await load('request-log')
  const entry = toEntry(completed({ error: new Error('upstream down') }), 1000)
  assert.deepEqual(entry, {
    time: 1000, model: 'openai/gpt', provider: 'openai', protocol: 'openai-chat', key: 'laptop',
    inputTokens: 10, outputTokens: 5, cachedTokens: 4, error: 'upstream down'
  })
  assert.doesNotMatch(JSON.stringify(entry), /secret/)

  const first = host({ limit: 2 })
  const stop = await plugin.setup(first.api)
  const emit = first.state.events.get('llmhub:request-complete')
  for (const model of ['a/1', 'a/2', 'a/3']) emit(completed({ model }))
  const listed = first.state.routes.get('GET entries')()
  assert.deepEqual(listed.entries.map(item => item.model), ['a/3', 'a/2'], 'newest first, oldest dropped')
  assert.equal(first.state.metrics.get('today')(), 2)
  await stop()

  const second = host({ limit: 2 })
  second.state.storage.set('entries', first.state.storage.get('entries'))
  await plugin.setup(second.api)
  assert.equal(second.state.routes.get('GET entries')().entries.length, 2)
  second.state.routes.get('DELETE entries')()
  assert.equal(second.state.routes.get('GET entries')().entries.length, 0)
})

test('failure messages are found in every shape the gateway reports', async () => {
  for (const name of ['request-log', 'webhook']) {
    const { errorMessage } = await load(name)
    const upstream = 'The upstream is overloaded.'
    assert.equal(errorMessage(Object.assign(new Error(''), { statusCode: 503, data: { error: { message: upstream } } })), upstream)
    assert.equal(errorMessage(Object.assign(new Error(JSON.stringify({ error: { message: upstream } })), { _errorBody: { error: { message: upstream } } })), upstream)
    assert.equal(errorMessage(new Error(JSON.stringify({ error: { message: upstream } }))), upstream)
    assert.equal(errorMessage(new Error('plain')), 'plain')
    assert.equal(errorMessage('text'), 'text')
    assert.equal(errorMessage(undefined), '')
  }
})

test('webhook alerts only on failures, in each service format, without leaking credentials', async t => {
  const { default: plugin, body, describe } = await load('webhook')
  const failed = completed({ error: new Error('upstream down') })
  const text = describe(failed, 2)
  assert.match(text, /Model: openai\/gpt/)
  assert.match(text, /2 more failures/)
  assert.doesNotMatch(text, /secret/)
  assert.deepEqual(body('feishu', 'hi', failed), { msg_type: 'text', content: { text: 'hi' } })
  assert.deepEqual(body('dingtalk', 'hi', failed), { msgtype: 'text', text: { content: 'hi' } })
  assert.deepEqual(body('wecom', 'hi', failed), { msgtype: 'text', text: { content: 'hi' } })
  assert.doesNotMatch(JSON.stringify(body('json', 'hi', failed)), /secret/)

  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return new Response('{}') })
  const { api, state } = host({ url: 'https://hooks.example/bot?token=abc', format: 'feishu', interval: 60 })
  plugin.setup(api)
  const emit = state.events.get('llmhub:request-complete')
  await emit(completed())
  assert.equal(calls.length, 0, 'successful requests are ignored')
  await emit(failed)
  await emit(failed)
  assert.equal(calls.length, 1, 'alerts are spaced out')
  assert.equal(JSON.parse(calls[0].options.body).msg_type, 'text')

  const failing = host({ url: 'https://hooks.example/bot?token=abc', format: 'json', interval: 0 })
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed') })
  plugin.setup(failing.api)
  await failing.state.events.get('llmhub:request-complete')(failed)
  assert.equal(failing.state.warnings.length, 1)
  assert.doesNotMatch(failing.state.warnings[0], /token=abc/, 'the webhook URL is never logged')
})
