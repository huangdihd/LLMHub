import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) throw new Error('ADAPTER_BUILD not set — run via tests/run-all.sh')
const { ProviderStore, getProviderStore } = require(`${buildDir}/stores/provider.store.js`)
const data = new Map<string, any>()
Object.assign(globalThis, {
  useStorage: () => ({
    getItem: async (key: string) => structuredClone(data.get(key) ?? null),
    setItem: async (key: string, value: any) => { data.set(key, structuredClone(value)) },
    getKeys: async () => [...data.keys()]
  }),
  createError: (options: any) => Object.assign(new Error(options.message), options),
  defineEventHandler: (handler: any) => handler,
  readBody: async (event: any) => event.body,
  getRouterParam: (event: any) => event.name,
  throwFormattedError: (error: any) => { throw error }
})

// Compile only the handlers and mock infrastructure: no server or upstream network.
function handler(path: string) {
  const source = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports: any = {}
  const mockedRequire = (id: string) => {
    if (id.endsWith('/provider.store')) return { getProviderStore, validateProviderApiType: require(`${buildDir}/stores/provider.store.js`).validateProviderApiType }
    if (id.endsWith('/auth.store')) return { getAuthStore: () => ({ getSSRFConfig: async () => ({}) }) }
    if (id.endsWith('/loader')) return { ProviderLoader: { invalidateCache() {} } }
    if (id.endsWith('/validate-url')) return { validateBaseUrl: () => ({ valid: true }) }
    throw new Error(`Unexpected import ${id}`)
  }
  new Function('require', 'exports', source)(mockedRequire, exports)
  return exports.default
}
const create = handler('server/api/hub/providers.post.ts')
const update = handler('server/api/hub/providers/[name].put.ts')
const store = new ProviderStore()
let passed = 0
async function test(name: string, run: () => Promise<void>) {
  data.clear()
  try {
    await run()
    passed++
    console.log(`  ok - ${name}`)
  } catch (error) {
    console.error(`  FAIL - ${name}`, error)
    process.exitCode = 1
  }
}
const config = (name = 'test', protocol = 'openai') => ({
  name, protocol, enabled: true, connection: { api_key: 'test-only', base_url: '', timeout: 1234, max_retries: 2 }, models: []
})

await test('new OpenAI providers default to Responses through store and API', async () => {
  assert.equal((await store.create(config())).connection.api_type, 'responses')
  const result = await create({ body: { name: 'api' } })
  assert.equal(result.provider.connection.api_type, 'responses')
  assert.equal('api_key' in result.provider.connection, false)
})
await test('explicit protocols round-trip through flat and nested API fields', async () => {
  for (const api_type of ['responses', 'chat_completions']) {
    const result = await create({ body: { name: api_type, connection: { api_type } } })
    assert.equal(result.provider.connection.api_type, api_type)
    assert.equal((await store.get(api_type)).connection.api_type, api_type)
    assert.equal((await update({ name: api_type, body: { api_type: 'chat_completions' } })).provider.connection.api_type, 'chat_completions')
    assert.equal((await update({ name: api_type, body: { connection: { api_type: 'responses' } } })).provider.connection.api_type, 'responses')
  }
})
await test('legacy records remain unset on reads, save, and unrelated updates', async () => {
  data.set('providers:legacy', config('legacy'))
  assert.equal((await store.get('legacy')).connection.api_type, undefined)
  assert.equal((await store.getAll())[0].connection.api_type, undefined)
  assert.equal((await store.save(await store.get('legacy'))).connection.api_type, undefined)
  const result = await update({ name: 'legacy', body: { display_name: 'Renamed' } })
  assert.equal(result.provider.connection.api_type, undefined)
  assert.equal(result.provider.connection.timeout, 1234)
})
await test('invalid API types cannot be hidden by flat/nested merge precedence', async () => {
  await store.create(config())
  for (const value of ['invalid', '', null, false, 1, {}, []]) {
    for (const body of [
      { api_type: value }, { connection: { api_type: value } },
      { api_type: value, connection: { api_type: 'responses' } },
      { api_type: 'responses', connection: { api_type: value } }
    ]) {
      await assert.rejects(create({ body: { name: 'invalid', ...body } }), { statusCode: 400 })
      await assert.rejects(update({ name: 'test', body }), { statusCode: 400 })
    }
    await assert.rejects(store.update('test', { connection: { api_type: value } }), { statusCode: 400 })
    await assert.rejects(store.create({ ...config('invalid'), connection: { api_type: value } }), { statusCode: 400 })
  }
  assert.equal((await store.get('test')).connection.api_type, 'responses')
})
await test('other protocols are not defaulted and unrelated connection settings survive', async () => {
  for (const protocol of ['claude', 'gemini', 'codex-subscription', 'claude-subscription', 'antigravity-subscription']) {
    const connection = { ...config().connection, version: 'v1', client_version: 'v2', auto_reset_on_quota_exhausted: false }
    await store.create({ ...config(protocol, protocol), connection })
    const result = await update({ name: protocol, body: { display_name: 'Edited' } })
    assert.equal(result.provider.connection.api_type, undefined)
    assert.equal(result.provider.connection.version, 'v1')
    assert.equal(result.provider.connection.client_version, 'v2')
    assert.equal(result.provider.connection.auto_reset_on_quota_exhausted, false)
  }
})
console.log(`${passed} provider settings tests passed`)
