import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import type { PluginAPI } from '../server/plugins-runtime/manager.ts'
import type { BuiltinPlugin } from '../builtin/catalog.ts'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('Run via tests/run-all.sh')
const { BuiltinPluginHost } = require(`${build}/../builtin/host.js`) as typeof import('../builtin/host.ts')
const { HookRegistry } = require(`${build}/core/hooks.js`) as typeof import('../server/core/hooks.ts')
const { ProviderRegistry } = require(`${build}/core/registry.js`) as typeof import('../server/core/registry.ts')
const { builtinCatalog } = require(`${build}/../builtin/catalog.js`) as typeof import('../builtin/catalog.ts')
const { orderBuiltinPlugins } = require(`${build}/../builtin/assembly.js`) as typeof import('../builtin/assembly.ts')

function fixture() {
  return new BuiltinPluginHost({
    hookRegistry: new HookRegistry(), providerRegistry: new ProviderRegistry(),
    storage: { async getItem() { return null }, async setItem() {}, async removeItem() {} }
  })
}

function plugin(id: string, setup: BuiltinPlugin['setup'] = () => {}, dependencies?: Record<string, string>): BuiltinPlugin {
  return { manifest: { id, name: id, version: '1.0.0', engines: { llmhub: '^1.0.0' }, dependencies }, layer: `./${id}`, setup }
}

test('builtin exports publish only after successful setup and require declared compatible dependencies', async () => {
  const host = fixture()
  const service = { answer: 42 }
  let captured!: PluginAPI
  await host.register(plugin('service', api => {
    captured = api
    api.provide(service)
    assert.equal(host.require('service'), undefined)
  }))
  assert.equal(host.require('service'), service)
  assert.throws(() => captured.provide({}), /registration is closed/)
  await host.register(plugin('consumer', api => {
    assert.equal(api.require('service'), service)
    assert.throws(() => api.require('undeclared'), /must be declared/)
  }, { service: '^1.0.0' }))
  const optional = plugin('optional', api => assert.equal(api.require('service'), undefined))
  optional.manifest.optionalDependencies = { service: '^2.0.0' }
  await host.register(optional)
  assert.deepEqual(host.list().find(record => record.id === 'service')?.requiredBy, ['consumer'])
  await host.shutdown()
  assert.equal(host.require('service'), undefined)
  assert.throws(() => captured.require('service'), /inactive/)
  assert.throws(() => captured.storage.getItem('key'), /inactive/)
})

test('builtin manifests and required dependencies fail validation before setup', async () => {
  const host = fixture()
  let called = false
  const invalid = plugin('invalid', () => { called = true })
  invalid.manifest.version = 'legacy'
  await assert.rejects(host.register(invalid), /semver/)
  invalid.manifest.version = '1.0.0'
  invalid.manifest.engines = { llmhub: '^999.0.0' }
  await assert.rejects(host.register(invalid), /requires plugin API/)
  await assert.rejects(host.register(plugin('missing', () => { called = true }, { service: '^1.0.0' })), /not installed/)
  await host.register(plugin('service'))
  await assert.rejects(host.register(plugin('mismatch', () => { called = true }, { service: '^2.0.0' })), /installed version/)
  assert.equal(called, false)
  await host.shutdown()
})

test('failed setup revokes retained API access and discards exports; cleanup failure does not retain exports', async () => {
  const host = fixture()
  let captured!: PluginAPI
  await assert.rejects(host.register(plugin('broken', api => {
    captured = api
    api.provide({ stale: true })
    api.registerRoute('GET', 'status', () => 'ready')
    throw new Error('setup failure')
  })), /setup failure/)
  assert.equal(host.require('broken'), undefined)
  assert.throws(() => captured.storage.setItem('key', 1), /inactive/)
  assert.throws(() => host.dispatchRoute('broken', 'GET', 'status', {} as any), /not found/)
  await host.register(plugin('broken', api => {
    api.provide({ fresh: true })
    return () => {
      assert.equal(host.require('broken'), undefined)
      assert.throws(() => api.require('broken'), /inactive/)
      throw new Error('cleanup failure')
    }
  }))
  await assert.rejects(host.shutdown(), /cleanup failed/)
  assert.equal(host.require('broken'), undefined)
  assert.deepEqual(host.list(), [])
})

test('shutdown waits for pending setup, then revokes exports and retained APIs', async () => {
  const host = fixture()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let captured!: PluginAPI
  let cleaned = false
  const registration = host.register(plugin('pending', async api => {
    captured = api
    api.provide({ ready: true })
    await barrier
    return () => { cleaned = true }
  }))
  await Promise.resolve()
  const shutdown = host.shutdown()
  assert.equal(host.require('pending'), undefined)
  release()
  await Promise.all([registration, shutdown])
  assert.equal(cleaned, true)
  assert.equal(host.require('pending'), undefined)
  assert.throws(() => captured.storage.removeItem('key'), /inactive/)
})

test('builtin ordering rejects cycles and preserves parser and equal-priority hook precedence', async () => {
  const ordered = orderBuiltinPlugins(builtinCatalog)
  const positions = new Map(ordered.map((entry, index) => [entry.manifest.id, index]))
  for (const entry of ordered) {
    for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
      assert.ok(positions.get(dependency)! < positions.get(entry.manifest.id)!)
    }
  }
  assert.deepEqual(ordered.filter(entry => entry.manifest.id.startsWith('ingress-')).map(entry => entry.manifest.id),
    ['ingress-openai', 'ingress-claude', 'ingress-gemini'])
  assert.throws(() => orderBuiltinPlugins([plugin('first', undefined, { second: '*' }), plugin('second', undefined, { first: '*' })]), /cycle/)
  assert.throws(() => orderBuiltinPlugins([plugin('first'), plugin('first')]), /Duplicate/)
  const hookOrder = async (plugins: readonly BuiltinPlugin[]) => {
    const hooks: Array<{ id: string; priority?: number }> = []
    const api = { registerHook: (hook: { id: string; priority?: number }) => hooks.push(hook),
      registerProvider() {}, registerProtocol() {}, registerIngress() {} } as unknown as PluginAPI
    for (const entry of plugins) await entry.setup!(api)
    return hooks.sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0)).map(hook => hook.id)
  }
  assert.deepEqual(await hookOrder(ordered), await hookOrder(builtinCatalog))
})
