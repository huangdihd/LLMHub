import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import type { PluginAPI } from '../server/plugins-runtime/manager.ts'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('Run via tests/run-all.sh')
const { BuiltinPluginHost } = require(`${build}/../builtin/host.js`) as typeof import('../builtin/host.ts')
const { HookRegistry } = require(`${build}/core/hooks.js`) as typeof import('../server/core/hooks.ts')
const { ProviderRegistry } = require(`${build}/core/registry.js`) as typeof import('../server/core/registry.ts')
const { PluginManager } = require(`${build}/plugins-runtime/manager.js`) as typeof import('../server/plugins-runtime/manager.ts')

function fixture() {
  const hookRegistry = new HookRegistry()
  const providerRegistry = new ProviderRegistry()
  const storage = {
    async getItem<T>(): Promise<T | null> { return null },
    async setItem() {},
    async removeItem() {}
  }
  const host = new BuiltinPluginHost({ hookRegistry, providerRegistry, storage })
  return { host, hookRegistry, providerRegistry, storage }
}

test('builtin host namespaces registrations, closes setup, and returns isolated records', async () => {
  const { host, hookRegistry } = fixture()
  let captured!: PluginAPI
  let calls = 0
  const plugin = {
    manifest: { id: 'test-policy', version: '1.0.0' }, layer: './test-policy',
    setup(api: PluginAPI) {
      captured = api
      api.registerHook({ id: 'check', onBeforeIdentity() { calls++ } })
    }
  }
  await host.register(plugin)
  await assert.rejects(host.register(plugin), /already registered/)
  assert.throws(() => captured.registerHook({ id: 'late' }), /registration is closed/)
  assert.deepEqual(host.list()[0].hooks, ['test-policy:check'])
  host.list()[0].hooks.length = 0
  assert.equal(host.list()[0].hooks.length, 1)
  await hookRegistry.admission('onBeforeIdentity', { event: {} as any, incomingProtocol: 'test', model: '' })
  assert.equal(calls, 1)
})

test('failed builtin setup rolls back its registrations and allows retry', async () => {
  const { host, hookRegistry } = fixture()
  let calls = 0
  const plugin = {
    manifest: { id: 'test-policy', version: '1.0.0' }, layer: './test-policy',
    setup(api: PluginAPI) {
      api.registerHook({ id: 'check', onBeforeIdentity() { calls++ } })
      throw new Error('setup failed')
    }
  }
  await assert.rejects(host.register(plugin), /setup failed/)
  assert.deepEqual(host.list(), [])
  await hookRegistry.admission('onBeforeIdentity', { event: {} as any, incomingProtocol: 'test', model: '' })
  assert.equal(calls, 0)
  await host.register({ ...plugin, setup(api) { api.registerHook({ id: 'check' }) } })
})

test('runtime manager lists builtins but rejects every mutation and leaves hooks active', async () => {
  const { host, hookRegistry, providerRegistry, storage } = fixture()
  await host.register({ manifest: { id: 'test-policy', version: '1.0.0' }, layer: './test-policy', setup() {} })
  const manager = new PluginManager({ hookRegistry, providerRegistry, storage, builtinPlugins: () => host.list() })
  assert.equal(manager.list()[0].builtin, true)
  for (const operation of ['enable', 'disable', 'reload', 'uninstall'] as const) {
    await assert.rejects(manager[operation]('test-policy'), /read-only/)
  }
  await assert.rejects(manager.updateConfig('test-policy', {}), /read-only/)
  assert.throws(() => manager.getConfig('test-policy'), /read-only/)
  await manager.shutdown()
  assert.equal(host.list()[0].enabled, true)
})

test('non-Nitro assembly registers the complete catalog only once', async () => {
  const assembly = require(`${build}/../builtin/assembly.js`)
  const again = require(`${build}/../builtin/assembly.js`)
  const { builtinCatalog } = require(`${build}/../builtin/catalog.js`)
  const ready = assembly.initializeBuiltinPlugins()
  assert.equal(ready, again.initializeBuiltinPlugins())
  await ready
  assert.equal(assembly.builtinHost, again.builtinHost)
  assert.deepEqual(assembly.builtinHost.list().map((record: any) => record.id), builtinCatalog.map((plugin: any) => plugin.manifest.id))
  assert.equal(assembly.builtinHost.list().length, 8)
})

test('async default setup reserves IDs and retains async cleanup through shutdown', async () => {
  const { host, hookRegistry } = fixture()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let captured!: PluginAPI
  let cleaned = 0
  const plugin = {
    manifest: { id: 'async-policy', version: '1.0.0' }, layer: './async-policy',
    default: {
      async setup(api: PluginAPI) {
        captured = api
        await barrier
        api.registerHook({ id: 'check', onBeforeIdentity() { return { status: 403, message: 'blocked', code: 'blocked' } } })
        api.registerRoute('GET', 'status', () => 'ready')
        return async () => { await Promise.resolve(); cleaned++ }
      }
    }
  }
  const registration = host.register(plugin)
  await assert.rejects(host.register(plugin), /already registered/)
  assert.deepEqual(host.list(), [])
  release()
  await registration
  assert.equal(host.dispatchRoute('async-policy', 'GET', 'status', {} as any), 'ready')
  assert.throws(() => captured.registerHook({ id: 'late' }), /registration is closed/)
  await Promise.all([host.shutdown(), host.shutdown()])
  assert.equal(cleaned, 1)
  assert.deepEqual(host.list(), [])
  assert.throws(() => host.dispatchRoute('async-policy', 'GET', 'status', {} as any), /not found/)
  assert.equal(await hookRegistry.admission('onBeforeIdentity', { event: {} as any, incomingProtocol: 'test', model: '' }), undefined)
  await assert.rejects(host.register(plugin), /shutting down/)
})

test('async rejection rolls back registrations made on both sides of await', async () => {
  const { host } = fixture()
  await assert.rejects(host.register({
    manifest: { id: 'async-policy', version: '1.0.0' }, layer: './async-policy',
    async setup(api) {
      api.registerRoute('GET', 'before', () => 'before')
      await Promise.resolve()
      api.registerRoute('GET', 'after', () => 'after')
      throw new Error('async failure')
    }
  }), /async failure/)
  for (const path of ['before', 'after']) {
    assert.throws(() => host.dispatchRoute('async-policy', 'GET', path, {} as any), /not found/)
  }
  await host.register({ manifest: { id: 'async-policy', version: '1.0.0' }, layer: './async-policy', setup() {} })
  await host.shutdown()
})

test('shutdown waits for pending setup and cleans all plugins despite cleanup failures', async () => {
  const { host } = fixture()
  let cleaned = false
  const first = host.register({
    manifest: { id: 'first', version: '1.0.0' }, layer: './first',
    async setup() { await Promise.resolve(); return () => { cleaned = true } }
  })
  const second = host.register({
    manifest: { id: 'second', version: '1.0.0' }, layer: './second',
    async setup() { return async () => { throw new Error('cleanup failed') } }
  })
  await assert.rejects(host.shutdown(), /cleanup failed/)
  await Promise.all([first, second])
  assert.equal(cleaned, true)
  assert.deepEqual(host.list(), [])
})
