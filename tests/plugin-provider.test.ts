import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const directory = process.env.ADAPTER_BUILD
if (!directory) throw new Error('Run through tests/run-all.sh')
const { providerRegistry } = require(`${directory}/core/registry.js`)
const { ProviderStore, validatePluginConnectionExtra, validateRegisteredProvider } = require(`${directory}/stores/provider.store.js`)
;(globalThis as any).createError = (options: any) => Object.assign(new Error(options.message), options)

const definition = {
  id: 'plugin-test:echo', displayName: 'Test echo',
  connectionSchema: [
    { key: 'token', type: 'secret', required: true },
    { key: 'count', type: 'number', default: 3 },
    { key: 'active', type: 'boolean', default: false },
    { key: 'mode', type: 'select', options: [{ label: 'One', value: 'one' }] }
  ],
  secretConnectionFields: ['extra.token'],
  createAdapter() { throw new Error('not needed') },
  async fetchModels() { return [] }
}
const unregister = providerRegistry.register(definition)
try {
  assert.throws(() => validateRegisteredProvider('not-loaded:echo'))
  assert.throws(() => validatePluginConnectionExtra(definition.id, {}))
  assert.throws(() => validatePluginConnectionExtra(definition.id, { token: 'secret', count: '2' }))
  assert.throws(() => validatePluginConnectionExtra(definition.id, { token: 'secret', mode: 'two' }))
  assert.throws(() => validatePluginConnectionExtra(definition.id, { token: 'secret', unknown: 1 }))
  const extra = validatePluginConnectionExtra(definition.id, { token: 'secret' })
  assert.deepEqual(extra, { token: 'secret', count: 3, active: false })
  assert.equal(validatePluginConnectionExtra(definition.id, { count: 4 }, extra).token, 'secret')
  const store = new ProviderStore()
  const configuration = { name: 'plugin-test', protocol: definition.id, connection: { api_key: '', base_url: '', extra }, models: [] }
  const safe = store.sanitize(configuration)
  assert.ok(!JSON.stringify(safe).includes('secret'))
  assert.equal(safe.connection.extra.count, 3)
  assert.equal(configuration.connection.extra.token, 'secret')
  unregister()
  assert.ok(!JSON.stringify(store.sanitize(configuration)).includes('secret'))
  console.log('  ok - plugin connection validation, secret preservation, loaded/unloaded sanitization')
} finally {
  unregister()
}

// Exercise the actual route bodies without starting Nitro or contacting an upstream.
const { readFileSync } = await import('node:fs')
const typescript = require('typescript')
const stored = new Map<string, any>()
Object.assign(globalThis, {
  useStorage: () => ({
    getItem: async (key: string) => structuredClone(stored.get(key) ?? null),
    setItem: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)) }
  }),
  defineEventHandler: (handler: unknown) => handler,
  readBody: async (event: any) => event.body,
  getRouterParam: (event: any) => event.name,
  throwFormattedError: (error: unknown) => { throw error }
})
function loadHandler(path: string) {
  const source = typescript.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }
  }).outputText
  const exports: any = {}
  const mockedRequire = (id: string) => {
    if (id.endsWith('/provider.store')) return require(`${directory}/stores/provider.store.js`)
    if (id.endsWith('/registry')) return { providerRegistry }
    if (id.endsWith('/auth.store')) return { getAuthStore: () => ({ getSSRFConfig: async () => ({}) }) }
    if (id.endsWith('/loader')) return { ProviderLoader: { invalidateCache() {} } }
    if (id.endsWith('/validate-url')) return { validateBaseUrl: (url: string) => ({ valid: url === 'https://public.example', reason: 'blocked test URL' }) }
    throw new Error(`Unexpected import: ${id}`)
  }
  new Function('require', 'exports', source)(mockedRequire, exports)
  return exports.default
}
const createProvider = loadHandler('server/api/hub/providers.post.ts')
const updateProvider = loadHandler('server/api/hub/providers/[name].put.ts')
const providerTypes = loadHandler('server/api/hub/provider-types.get.ts')
const unregisterTyped = providerRegistry.register({
  ...definition,
  connectionSchema: [
    { key: 'choice', type: 'select', options: [{ label: 'Zero', value: 0 }, { label: 'False', value: false }, { label: 'String zero', value: '0' }] },
    { key: 'credential', type: 'text', required: true, default: 'private-default' }
  ],
  secretConnectionFields: ['extra.credential']
})
try {
  for (const choice of [0, false, '0']) {
    assert.equal(validatePluginConnectionExtra(definition.id, { choice, credential: 'private' }).choice, choice)
  }
  assert.throws(() => validatePluginConnectionExtra(definition.id, { choice: true, credential: 'private' }))
  const types = await providerTypes()
  const credentialField = types.find((type: any) => type.id === definition.id).connectionSchema.find((field: any) => field.key === 'credential')
  assert.equal(credentialField.type, 'secret')
  assert.equal(Object.hasOwn(credentialField, 'default'), false)
  assert.equal(providerRegistry.get(definition.id).connectionSchema[1].type, 'text', 'API projection must not mutate the registered schema')
  const store = new ProviderStore()
  await store.create({ name: 'ssrf', protocol: definition.id, connection: { api_key: '', base_url: '', extra: { credential: 'private' } }, models: [] })
  await assert.rejects(() => updateProvider({ name: 'ssrf', body: {
    base_url: 'https://public.example', connection: { base_url: 'http://127.0.0.1' }
  } }), { statusCode: 400 })
  assert.equal((await store.get('ssrf')).connection.base_url, '')
  await store.create({ name: 'builtin-ssrf', protocol: 'openai', connection: { api_key: '', base_url: '' }, models: [] })
  await assert.rejects(() => updateProvider({ name: 'builtin-ssrf', body: {
    base_url: 'https://public.example', connection: { base_url: 'http://127.0.0.1' }
  } }), { statusCode: 400 })
  const created = await createProvider({ body: { name: 'typed-api', protocol: definition.id, connection: { extra: { choice: false, credential: 'private' } } } })
  assert.deepEqual(created.provider.connection.extra, { choice: false })
  const updated = await updateProvider({ name: 'typed-api', body: { connection: { extra: { choice: 0, credential: '' } } } })
  assert.deepEqual(updated.provider.connection.extra, { choice: 0 })
  assert.equal((await store.get('typed-api')).connection.extra.credential, 'private')
  console.log('  ok - typed selections, secret schema projection, effective URL validation')
} finally {
  unregisterTyped()
}
