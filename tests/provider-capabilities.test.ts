import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('Run via tests/run-all.sh')
const { providerRegistry, ProviderRegistry } = require(`${build}/core/registry.js`)
const { HookRegistry } = require(`${build}/core/hooks.js`)
const { BuiltinPluginHost } = require(`${build}/../builtin/host.js`)
const { PluginManager } = require(`${build}/plugins-runtime/manager.js`)
const { builtinHost } = require(`${build}/../builtin/assembly.js`)
const { getSubscriptionUsage, consumeSubscriptionResetCredit, supportsSubscriptionUsage, supportsSubscriptionReset } = require(`${build}/services/subscription-usage.js`)

function memoryStorage() {
  const values = new Map<string, unknown>()
  return {
    async getItem(key: string) { return values.get(key) ?? null },
    async setItem(key: string, value: unknown) { values.set(key, value) },
    async removeItem(key: string) { values.delete(key) }
  }
}

test('assembly keeps all six persisted provider IDs and lists their owning read-only plugins', () => {
  const expected = [
    ['provider-openai', 'openai'], ['provider-claude', 'claude'], ['provider-gemini', 'gemini'],
    ['provider-codex', 'codex-subscription'], ['provider-claude-subscription', 'claude-subscription'],
    ['provider-antigravity', 'antigravity-subscription']
  ]
  assert.equal(providerRegistry.defaultProviderId, 'openai')
  for (const [pluginId, protocol] of expected) {
    const record = builtinHost.list().find((item: any) => item.id === pluginId)
    assert.equal(record.builtin, true)
    assert.equal(record.enabled, true)
    assert.deepEqual(record.providers, [protocol])
    assert.ok(providerRegistry.get(protocol))
  }
})

test('builtin provider IDs remain unprefixed, reject collisions and roll back failed setup', async () => {
  const registry = new ProviderRegistry()
  const host = new BuiltinPluginHost({ providerRegistry: registry, hookRegistry: new HookRegistry(), storage: memoryStorage() })
  const definition = { id: 'persisted', secretConnectionFields: [], createAdapter() { return {} }, async fetchModels() { return [] } }
  const plugin = { manifest: { id: 'owner-plugin', name: 'Owner', version: '1.0.0' }, layer: '.', setup(api: any) { api.registerProvider(definition) } }
  try {
    await host.register(plugin)
    assert.equal(registry.get('persisted').id, 'persisted')
    assert.equal(registry.get('owner-plugin:persisted'), undefined)
    await assert.rejects(host.register({ ...plugin, manifest: { ...plugin.manifest, id: 'other-plugin' } }), /already registered/)
    await assert.rejects(host.register({ ...plugin, manifest: { ...plugin.manifest, id: 'failed-plugin' }, setup(api: any) {
      api.registerProvider({ ...definition, id: 'rolled-back' })
      throw new Error('setup failure')
    } }), /setup failure/)
    assert.equal(registry.get('rolled-back'), undefined)
    assert.deepEqual(registry.list().map((item: any) => item.id), ['persisted'])
  } finally { await host.shutdown() }
  assert.deepEqual(registry.list(), [])
})

test('runtime provider capabilities survive namespacing and drive generic usage/reset dispatch', async () => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'llmhub-capabilities-'))
  const manager = new PluginManager({ directory: root, storage: memoryStorage(), providerRegistry, hookRegistry: new HookRegistry() })
  const directory = path.join(root, 'capability-test')
  try {
    await mkdir(directory)
    await writeFile(path.join(directory, 'plugin.json'), JSON.stringify({ id: 'capability-test', name: 'Capability test', version: '1.0.0', entry: 'index.mjs' }))
    await writeFile(path.join(directory, 'index.mjs'), `export default { setup(api) {
      let calls = 0;
      api.registerRoute('POST', 'login/start', () => ({ status: 'pending' }));
      api.registerProvider({
        id: 'upstream', secretConnectionFields: [],
        management: { createConnectionDefaults: { version: 'test' }, protectedConnectionFields: ['api_key'] },
        login: { path: '/api/hub/plugins/capability-test/api/login/start' },
        createAdapter() { return {} }, async fetchModels() { return [] },
        async refreshAccessToken(config) { return { ...config, connection: { ...config.connection, api_key: 'refreshed' } } },
        async subscriptionUsage(config) { return { provider: config.name, protocol: config.protocol, windows: [], fetched_at: String(++calls) } },
        async resetSubscriptionUsage(config, credit, key) { return { code: credit + ':' + key, windows_reset: 1 } }
      });
    } }`)
    await manager.scan()
    await manager.enable('capability-test')
    const protocol = 'capability-test:upstream'
    const definition = providerRegistry.get(protocol)
    const configuration = { name: 'capability-fixture', protocol, connection: { api_key: 'old', base_url: '' }, models: [] }
    assert.equal(definition.management.createConnectionDefaults.version, 'test')
    assert.deepEqual(definition.management.protectedConnectionFields, ['api_key'])
    assert.equal(definition.login.path, '/api/hub/plugins/capability-test/api/login/start')
    assert.deepEqual(await manager.dispatchRoute('capability-test', 'POST', 'login/start', {}), { status: 'pending' })
    assert.equal((await definition.refreshAccessToken(configuration)).connection.api_key, 'refreshed')
    assert.equal(supportsSubscriptionUsage(protocol), true)
    assert.equal(supportsSubscriptionReset(protocol), true)
    assert.equal((await getSubscriptionUsage(configuration)).fetched_at, '1')
    assert.equal((await getSubscriptionUsage(configuration)).fetched_at, '1')
    assert.deepEqual(await consumeSubscriptionResetCredit(configuration, 'credit', 'request'), { code: 'credit:request', windows_reset: 1 })
    assert.equal((await getSubscriptionUsage(configuration)).fetched_at, '2')
    await manager.disable('capability-test')
    assert.equal(supportsSubscriptionUsage(protocol), false)
    assert.equal(supportsSubscriptionReset(protocol), false)
    await assert.rejects(getSubscriptionUsage(configuration), { statusCode: 400 })
  } finally {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
