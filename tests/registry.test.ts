import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const buildDirectory = process.env.ADAPTER_BUILD
if (!buildDirectory) throw new Error('ADAPTER_BUILD not set — run via tests/run-all.sh')
const { ProviderRegistry } = require(`${buildDirectory}/core/registry.js`)
const { ProtocolRegistry } = require(`${buildDirectory}/core/protocol-registry.js`)
const { providerRegistry } = require(`${buildDirectory}/core/registry.js`)
const { BUILTIN_PROVIDER_IDS } = require(`${buildDirectory}/../builtin/provider-ids.js`)
const { protocolRegistry } = require(`${buildDirectory}/core/protocol-registry.js`)
const { ProviderManager } = require(`${buildDirectory}/providers/manager.js`)
const { ProviderLoader } = require(`${buildDirectory}/providers/loader.js`)
const { ProviderStore } = require(`${buildDirectory}/stores/provider.store.js`)

let passed = 0
async function test(name: string, run: () => void | Promise<void>) {
  await run()
  passed++
  console.log(`  ok - ${name}`)
}

function configuration(protocol = 'registry-test') {
  return {
    name: 'registry-test', display_name: 'Registry test', protocol, enabled: true,
    use_custom_models: false, models: [],
    connection: {
      api_key: 'secret', refresh_token: 'refresh', id_token: 'identity', device_id: 'device',
      account_id: 'account', project_id: 'project', account_email: 'email',
      base_url: 'https://example.invalid', timeout: 1234
    }
  }
}

await test('built-in provider and protocol registrations retain their IDs and parser order', () => {
  assert.deepEqual(providerRegistry.list().map((definition: any) => definition.id), Object.values(BUILTIN_PROVIDER_IDS))
  assert.deepEqual(protocolRegistry.list().map((definition: any) => definition.id), [
    'openai-chat', 'openai-completion', 'openai-responses',
    'claude-messages', 'claude-completion', 'gemini-generate'
  ])
  for (const definition of protocolRegistry.list()) {
    assert.equal(definition.createParser().name, definition.id)
    assert.equal(definition.createSerializer().name, definition.id)
  }
})

await test('registries reject duplicate and empty IDs without replacing a definition', () => {
  for (const registry of [new ProviderRegistry(), new ProtocolRegistry()]) {
    const definition = { id: 'test' }
    registry.register(definition)
    assert.throws(() => registry.register({ id: 'test' }), /already registered/)
    assert.throws(() => registry.register({ id: ' ' }), /must not be empty/)
    assert.equal(registry.get('test'), definition)
    assert.equal(registry.get('missing'), undefined)
    const snapshot = registry.list()
    snapshot.length = 0
    assert.equal(registry.list().length, 1)
  }
})

await test('built-ins and unknown protocols strip every existing credential field', () => {
  const store = new ProviderStore()
  for (const protocol of [...Object.values(BUILTIN_PROVIDER_IDS), 'unknown']) {
    const config = configuration(protocol as string)
    assert.deepEqual(store.sanitize(config).connection, {
      base_url: config.connection.base_url, timeout: 1234, authenticated: true
    })
    config.connection.refresh_token = ''
    assert.equal(store.sanitize(config).connection.authenticated, !String(protocol).endsWith('-subscription'))
    assert.equal(config.connection.api_key, 'secret')
  }
})

await test('a registered provider drives adapter creation, discovery and management sanitization', async () => {
  const config = configuration()
  const models = [{ id: 'registry-test/model', provider: 'registry-test', name: 'model', display_name: 'Model' }]
  const adapter = { name: 'registry-test' }
  let discoveries = 0
  let discoveryContext: any
  Object.assign(config.connection, { extension_secret: 'extension', authenticated: false, public_field: 'visible' })
  providerRegistry.register({
    id: config.protocol,
    createAdapter: (received: any) => { assert.equal(received, config); return adapter },
    fetchModels: async (received: any, context: any) => {
      assert.equal(received, config)
      discoveryContext = context
      discoveries++
      return models
    },
    secretConnectionFields: ['extension_secret', 'authenticated']
  })
  const previousStorage = (globalThis as any).useStorage
  ;(globalThis as any).useStorage = () => ({
    getKeys: async () => ['providers:registry-test'], getItem: async () => config
  })
  try {
    const manager = new ProviderManager()
    await manager.loadProviders()
    assert.equal(manager.getAdapter(config.name), adapter)
    assert.deepEqual(await manager.getProviderModels(config.name), models)
    assert.equal(discoveries, 1)
    assert.equal(new ProviderStore().sanitize(config).connection.authenticated, true)
    assert.equal(typeof discoveryContext.fetcher, 'function')
    assert.deepEqual(new ProviderStore().sanitize(config).connection, {
      base_url: config.connection.base_url, timeout: 1234, public_field: 'visible', authenticated: true
    })
    assert.equal((config.connection as any).extension_secret, 'extension')
    assert.equal((config.connection as any).authenticated, false)
    config.use_custom_models = true
    config.models = [{ id: 'custom', display_name: 'Custom' }] as any
    assert.deepEqual(await manager.getProviderModels(config.name), [{
      id: 'registry-test/custom', provider: 'registry-test', name: 'custom', display_name: 'Custom', capabilities: undefined
    }])
    assert.equal(discoveries, 1)
  } finally {
    ;(globalThis as any).useStorage = previousStorage
    ProviderLoader.invalidateCache()
  }
})

await test('discovery context enforces ten-second timeouts and exactly one retry', async () => {
  const config = configuration('registry-fetcher')
  Object.assign(config.connection, { enable_timeout: false, max_retries: 9 })
  const previousStorage = (globalThis as any).useStorage
  const previousFetch = globalThis.fetch
  const previousSetTimeout = globalThis.setTimeout
  const timeouts: number[] = []
  let attempts = 0
  providerRegistry.register({
    id: config.protocol,
    createAdapter: () => ({ name: config.name }),
    secretConnectionFields: [],
    fetchModels: async (_configuration: any, context: any) => {
      const response = await context.fetcher('https://example.invalid/models', {
        headers: { 'x-discovery': 'test' }, timeout: 1, enable_timeout: false, maxRetries: 9
      })
      assert.equal(response.status, 503)
      return []
    }
  })
  ;(globalThis as any).useStorage = () => ({ getKeys: async () => ['providers:registry-test'], getItem: async () => config })
  globalThis.fetch = async (_url, options) => {
    attempts++
    assert.equal((options?.headers as any)['x-discovery'], 'test')
    assert.ok(options?.signal instanceof AbortSignal)
    return new Response('', { status: 503 })
  }
  globalThis.setTimeout = ((callback: any, delay: number, ...arguments_: any[]) => {
    timeouts.push(delay)
    return previousSetTimeout(callback, delay === 1000 ? 0 : delay, ...arguments_)
  }) as typeof setTimeout
  try {
    const loader = new ProviderLoader()
    await loader.loadAll()
    assert.deepEqual(await loader.fetchModels(config.name), [])
    assert.equal(attempts, 2)
    assert.deepEqual(timeouts, [10_000, 1000, 10_000])
  } finally {
    globalThis.fetch = previousFetch
    globalThis.setTimeout = previousSetTimeout
    ;(globalThis as any).useStorage = previousStorage
  }
})

await test('registered refresh-token requirements preserve authentication semantics', () => {
  const config = configuration('registry-refresh')
  providerRegistry.register({
    id: config.protocol, createAdapter: () => ({ name: config.name }),
    fetchModels: async () => [], secretConnectionFields: [], requiresRefreshToken: true
  })
  const store = new ProviderStore()
  assert.equal(store.sanitize(config).connection.authenticated, true)
  config.connection.refresh_token = ''
  assert.equal(store.sanitize(config).connection.authenticated, false)
  config.connection.refresh_token = 'refresh'
  config.connection.api_key = ''
  assert.equal(store.sanitize(config).connection.authenticated, false)
})

await test('unknown protocols are logged and skipped even with custom models', async () => {
  const config = configuration('unknown')
  config.use_custom_models = true
  config.models = [{ id: 'custom', display_name: 'Custom' }] as any
  const previousStorage = (globalThis as any).useStorage
  const previousWarning = console.warn
  const warnings: string[] = []
  ;(globalThis as any).useStorage = () => ({ getKeys: async () => ['providers:registry-test'], getItem: async () => config })
  console.warn = (message: string) => { warnings.push(message) }
  try {
    const manager = new ProviderManager()
    await manager.loadProviders()
    assert.equal(manager.getAdapter(config.name), undefined)
    assert.deepEqual(await manager.getProviderModels(config.name), [])
    assert.equal(warnings.length, 2)
    assert.ok(warnings.every(message => message.includes('unknown') && !message.includes('secret')))
  } finally {
    console.warn = previousWarning
    ;(globalThis as any).useStorage = previousStorage
  }
})

await test('registered parser and serializer factories are consumed by new managers', () => {
  const parser = { name: 'registry-protocol', canHandle: (url: string) => url === '/registry-protocol' }
  const serializer = { name: 'registry-protocol' }
  protocolRegistry.register({ id: parser.name, createParser: () => parser, createSerializer: () => serializer })
  const manager = new ProviderManager()
  assert.equal(manager.getParser('/registry-protocol', 'POST', {}), parser)
  assert.equal(manager.getSerializer(parser.name), serializer)
  assert.equal(manager.getSerializer('unknown'), undefined)
})

console.log(`${passed} registry tests passed`)
