import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import type { PluginAPI } from '../server/plugins-runtime/manager.ts'
import type { IngressDefinition } from '../server/core/ingress-registry.ts'
import type { ProtocolDefinition } from '../server/core/protocol-registry.ts'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('Run via tests/run-all.sh')
const { ProtocolRegistry } = require(`${build}/core/protocol-registry.js`)
const { IngressRegistry } = require(`${build}/core/ingress-registry.js`)
const { ProviderRegistry } = require(`${build}/core/registry.js`)
const { HookRegistry } = require(`${build}/core/hooks.js`)
const { BuiltinPluginHost } = require(`${build}/../builtin/host.js`)
const { PluginManager } = require(`${build}/plugins-runtime/manager.js`)

const protocol: ProtocolDefinition = {
  id: 'wire',
  createParser: () => ({ name: 'local-parser' }) as any,
  createSerializer: () => ({ name: 'local-serializer' }) as any
}
const ingress: IngressDefinition = {
  id: 'entry', pathPrefix: '/api/example', extractKey: () => '', missingKeyMessage: 'Key required',
  extractModel: () => ({ model: '', replace() {} }), rewriteBeforeRejection: false, sendError() {}
}
function fixture() {
  return {
    protocolRegistry: new ProtocolRegistry(), ingressRegistry: new IngressRegistry(),
    providerRegistry: new ProviderRegistry(), hookRegistry: new HookRegistry(),
    storage: { async getItem() { return null }, async setItem() {}, async removeItem() {} }
  }
}

test('registries preserve insertion precedence, raw prefixes and replacement-safe disposal', () => {
  const { protocolRegistry, ingressRegistry } = fixture()
  const removeProtocol = protocolRegistry.register(protocol)
  assert.throws(() => protocolRegistry.register(protocol), /already registered/)
  removeProtocol()
  const replacement = { ...protocol }
  protocolRegistry.register(replacement)
  removeProtocol()
  assert.equal(protocolRegistry.get('wire'), replacement)
  const removeIngress = ingressRegistry.register(ingress)
  ingressRegistry.register({ ...ingress, id: 'nested', pathPrefix: '/api/example/nested' })
  assert.equal(ingressRegistry.match('/api/example/nested').id, 'entry')
  assert.equal(ingressRegistry.match('/api/examples').id, 'entry')
  assert.equal(ingressRegistry.match('/unrelated'), undefined)
  assert.throws(() => ingressRegistry.register({ ...ingress, id: 'collision' }), /prefix already registered/)
  removeIngress()
  ingressRegistry.register({ ...ingress })
  removeIngress()
  assert.equal(ingressRegistry.match('/api/example/nested').id, 'nested')
  assert.ok(ingressRegistry.get('entry'))
})

test('builtin protocol and ingress setup rolls back, retains original IDs and closes registration', async () => {
  const options = fixture()
  const host = new BuiltinPluginHost(options)
  let captured!: PluginAPI
  const plugin = { manifest: { id: 'wire-plugin', version: '1' }, layer: './wire-plugin', setup(api: PluginAPI) {
    captured = api
    api.registerProtocol(protocol)
    api.registerIngress(ingress)
  } }
  await assert.rejects(host.register({ ...plugin, setup(api: PluginAPI) { plugin.setup(api); throw new Error('rollback') } }), /rollback/)
  assert.deepEqual(options.protocolRegistry.list(), [])
  assert.deepEqual(options.ingressRegistry.list(), [])
  await host.register(plugin)
  assert.deepEqual(host.list()[0].protocols, ['wire'])
  assert.deepEqual(host.list()[0].ingresses, ['entry'])
  host.list()[0].protocols.length = 0
  assert.deepEqual(host.list()[0].protocols, ['wire'])
  assert.throws(() => captured.registerProtocol({ ...protocol, id: 'late' }), /closed/)
  assert.throws(() => captured.registerIngress({ ...ingress, id: 'late' }), /closed/)
  const snapshot = options.protocolRegistry.get('wire')
  await host.shutdown()
  await host.shutdown()
  assert.deepEqual(options.protocolRegistry.list(), [])
  assert.deepEqual(options.ingressRegistry.list(), [])
  assert.equal(snapshot.createParser().name, 'local-parser')
})

const registrations = `
  api.registerProtocol({ id: 'wire', createParser() { return { name: 'local-parser' } }, createSerializer() { return { name: 'local-serializer' } } });
  api.registerIngress({ id: 'entry', pathPrefix: '/api/runtime', extractKey() { return '' }, missingKeyMessage: 'Key required', extractModel() { return { model: '', replace() {} } }, rewriteBeforeRejection: false, sendError() {} });
`

async function runtimeFixture(tail = '') {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'llmhub-ingress-lifecycle-'))
  const pluginDirectory = path.join(directory, 'wire-plugin')
  await mkdir(pluginDirectory)
  await writeFile(path.join(pluginDirectory, 'plugin.json'), JSON.stringify({ id: 'wire-plugin', name: 'Wire Plugin', version: '1.0.0', entry: 'index.mjs' }))
  const entry = path.join(pluginDirectory, 'index.mjs')
  await writeFile(entry, `export default { async setup(api) { ${registrations} ${tail} } }`)
  const options = fixture()
  const manager = new PluginManager({ ...options, directory, timeoutMs: 100, cleanupTimeoutMs: 50 })
  await manager.scan()
  return { ...options, manager, directory, entry }
}

test('runtime enable, reload, disable and uninstall own namespaced registrations without revoking snapshots', async () => {
  const state = await runtimeFixture()
  const { manager, directory, protocolRegistry, ingressRegistry } = state
  try {
    await manager.enable('wire-plugin')
    assert.deepEqual(manager.list()[0].protocols, ['wire-plugin:wire'])
    assert.deepEqual(manager.list()[0].ingresses, ['wire-plugin:entry'])
    const snapshot = protocolRegistry.get('wire-plugin:wire')
    await manager.reload('wire-plugin')
    assert.notEqual(protocolRegistry.get('wire-plugin:wire'), snapshot)
    assert.equal(snapshot.createParser().name, 'local-parser')
    await manager.disable('wire-plugin')
    assert.deepEqual(protocolRegistry.list(), [])
    assert.deepEqual(ingressRegistry.list(), [])
    await manager.enable('wire-plugin')
    await manager.uninstall('wire-plugin')
    assert.deepEqual(protocolRegistry.list(), [])
    assert.deepEqual(ingressRegistry.list(), [])
  } finally { await manager.shutdown(); await rm(directory, { recursive: true, force: true }) }
})

for (const [name, tail] of [
  ['setup error', "throw new Error('setup failed')"],
  ['setup timeout', 'await new Promise(resolve => setTimeout(resolve, 180)); api.registerProtocol({ id: "late", createParser() {}, createSerializer() {} });']
]) {
  test(`runtime ${name} rolls back both registries and permits retry`, async () => {
    const { manager, directory, entry, protocolRegistry, ingressRegistry } = await runtimeFixture(tail)
    try {
      await assert.rejects(manager.enable('wire-plugin'), /activation failed/)
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.deepEqual(protocolRegistry.list(), [])
      assert.deepEqual(ingressRegistry.list(), [])
      await writeFile(entry, `export default { setup(api) { ${registrations} } }`)
      await manager.enable('wire-plugin')
      await manager.shutdown()
      assert.deepEqual(protocolRegistry.list(), [])
      assert.deepEqual(ingressRegistry.list(), [])
    } finally { await manager.shutdown(); await rm(directory, { recursive: true, force: true }) }
  })
}

test('runtime duplicate prefix rollback leaves builtin owner registered', async () => {
  const { manager, directory, protocolRegistry, ingressRegistry } = await runtimeFixture()
  const original = { ...ingress, pathPrefix: '/api/runtime' }
  ingressRegistry.register(original)
  try {
    await assert.rejects(manager.enable('wire-plugin'), /activation failed/)
    assert.deepEqual(protocolRegistry.list(), [])
    assert.equal(ingressRegistry.match('/api/runtime'), original)
  } finally { await manager.shutdown(); await rm(directory, { recursive: true, force: true }) }
})

test('omitted host registries are isolated rather than production singletons', async () => {
  const options = fixture()
  const { protocolRegistry: unusedProtocols, ingressRegistry: unusedIngresses, ...legacyOptions } = options
  const first = new BuiltinPluginHost(legacyOptions)
  const second = new BuiltinPluginHost(legacyOptions)
  const plugin = { manifest: { id: 'wire-plugin', version: '1' }, layer: './wire-plugin', setup(api: PluginAPI) {
    api.registerProtocol(protocol)
    api.registerIngress(ingress)
  } }
  await first.register(plugin)
  await second.register(plugin)
  assert.deepEqual(unusedProtocols.list(), [])
  assert.deepEqual(unusedIngresses.list(), [])
  await first.shutdown()
  assert.deepEqual(second.list()[0].protocols, ['wire'])
  await second.shutdown()
})

test('runtime persistence failure rolls back protocol and ingress registrations', async () => {
  const { manager, directory, storage, protocolRegistry, ingressRegistry } = await runtimeFixture()
  storage.setItem = async () => { throw new Error('storage unavailable') }
  try {
    await assert.rejects(manager.enable('wire-plugin'), /persistence failed/)
    assert.deepEqual(protocolRegistry.list(), [])
    assert.deepEqual(ingressRegistry.list(), [])
  } finally { await manager.shutdown(); await rm(directory, { recursive: true, force: true }) }
})
