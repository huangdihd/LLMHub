import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('Run through tests/run-all.sh')
const { PluginManager } = require(`${build}/plugins-runtime/manager.js`)
const { ProviderRegistry } = require(`${build}/core/registry.js`)
const { HookRegistry } = require(`${build}/core/hooks.js`)

test('scan reports incompatible npm metadata without executing code or blocking local plugins', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'llmhub-npm-lifecycle-'))
  const values = new Map<string, unknown>()
  const manager = new PluginManager({ directory, providerRegistry: new ProviderRegistry(), hookRegistry: new HookRegistry(), storage: {
    async getItem(key: string) { return values.get(key) ?? null },
    async setItem(key: string, value: unknown) { values.set(key, value) },
    async removeItem(key: string) { values.delete(key) },
  } })
  try {
    const incompatible = join(directory, 'node_modules', 'llmhub-plugin-incompatible')
    await mkdir(incompatible, { recursive: true })
    await writeFile(join(incompatible, 'package.json'), JSON.stringify({ name: 'llmhub-plugin-incompatible', version: '1.0.0', engines: { llmhub: '^99.0.0' }, llmhub: {} }))
    await writeFile(join(incompatible, 'index.mjs'), 'throw new Error("must not execute")')
    const local = join(directory, 'local-plugin')
    await mkdir(local)
    await writeFile(join(local, 'plugin.json'), JSON.stringify({ id: 'local-plugin', name: 'Local', version: '1.0.0' }))
    await writeFile(join(local, 'index.mjs'), 'export default { setup() {} }')
    const records = await manager.scan()
    const record = records.find((candidate: any) => candidate.id === 'incompatible')
    assert.equal(record.status, 'error')
    assert.match(record.error, /requires plugin API \^99\.0\.0/)
    await manager.enable('local-plugin')
    assert.equal(manager.list().find((candidate: any) => candidate.id === 'local-plugin').enabled, true)
    await assert.rejects(manager.enable('incompatible'), /requires plugin API/)
  } finally {
    await manager.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})

async function writePackage(directory: string, name: string, version: string, metadata: Record<string, unknown> = {}, setup = '') {
  const target = join(directory, 'node_modules', name)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'index.mjs', llmhub: {}, ...metadata }))
  await writeFile(join(target, 'index.mjs'), `export default { async setup(api) { ${setup} } }`)
}

async function lifecycleFixture(options: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'llmhub-npm-lifecycle-'))
  const values = new Map<string, unknown>()
  let failKey: string | undefined
  const manager = new PluginManager({ directory, providerRegistry: new ProviderRegistry(), hookRegistry: new HookRegistry(), storage: {
    async getItem(key: string) { return structuredClone(values.get(key) ?? null) },
    async setItem(key: string, value: unknown) {
      if (key === failKey) { failKey = undefined; throw new Error('injected persistence failure') }
      values.set(key, structuredClone(value))
    },
    async removeItem(key: string) { values.delete(key) },
    async getKeys(prefix: string) { return [...values.keys()].filter(key => key.startsWith(prefix)) },
  }, ...options })
  return { directory, values, manager, failNextWrite(key: string) { failKey = key }, async close() {
    await manager.shutdown()
    await rm(directory, { recursive: true, force: true })
  } }
}

test('scan isolates duplicate npm identities and still starts persisted local plugins', async () => {
  const fixture = await lifecycleFixture()
  try {
    for (const name of ['collision-one', 'collision-two']) {
      await writePackage(fixture.directory, name, '1.0.0', { llmhub: { id: 'same-id' } })
    }
    const local = join(fixture.directory, 'local-healthy')
    await mkdir(local)
    await writeFile(join(local, 'plugin.json'), JSON.stringify({ id: 'local-healthy', name: 'Local', version: '1.0.0' }))
    await writeFile(join(local, 'index.mjs'), 'export default { setup() {} }')
    fixture.values.set('runtime-plugins:local-healthy:state', { enabled: true, configuration: {} })
    await fixture.manager.scan()
    assert.equal(fixture.manager.list().find((record: any) => record.id === 'local-healthy')?.enabled, true)
  } finally { await fixture.close() }
})

test('explicit enable reports dependency preflight failure in the plugin record', async () => {
  const fixture = await lifecycleFixture({ npmRunner: async (_arguments: string[], target: string) => {
    await writePackage(target, 'missing-consumer', '1.0.0', { llmhub: { dependencies: { 'missing-plugin': '*' } } })
  } })
  try {
    await fixture.manager.installNpm({ name: 'missing-consumer' })
    await assert.rejects(fixture.manager.enable('missing-consumer'), /missing-plugin/)
    const record = fixture.manager.list().find((candidate: any) => candidate.id === 'missing-consumer')
    assert.equal(record.status, 'error')
    assert.match(record.error, /missing-plugin/)
    assert.equal(record.enabled, false)
  } finally { await fixture.close() }
})

test('updating an unconfigured disabled package does not require activation configuration', async () => {
  let version = '1.0.0'
  const fixture = await lifecycleFixture({ npmRunner: async (_arguments: string[], target: string) => {
    await writePackage(target, 'needs-configuration', version, { llmhub: { configSchema: [{ key: 'token', type: 'secret', label: 'Token', required: true }] } })
  } })
  try {
    await fixture.manager.installNpm({ name: 'needs-configuration' })
    version = '2.0.0'
    await fixture.manager.update('needs-configuration')
    const record = fixture.manager.list().find((candidate: any) => candidate.id === 'needs-configuration')
    assert.equal(record.manifest.version, version)
    assert.equal(record.enabled, false)
  } finally { await fixture.close() }
})

test('updating a disabled package does not execute setup or mutate plugin storage', async () => {
  let version = '1.0.0'
  const fixture = await lifecycleFixture({ npmRunner: async (_arguments: string[], target: string) => {
    await writePackage(target, 'disabled-package', version, {}, 'await api.storage.setItem("setup-ran", true)')
  } })
  try {
    await fixture.manager.installNpm({ name: 'disabled-package' })
    assert.equal(fixture.values.has('runtime-plugins:disabled-package:storage:setup-ran'), false)
    version = '2.0.0'
    await fixture.manager.update('disabled-package')
    assert.equal(fixture.manager.list()[0].enabled, false)
    assert.equal(fixture.manager.list()[0].manifest.version, version)
    assert.equal(fixture.values.has('runtime-plugins:disabled-package:storage:setup-ran'), false)
  } finally { await fixture.close() }
})

test('late npm persistence failure restores configuration, source and setup storage writes', async () => {
  let version = '1.0.0'
  const fixture = await lifecycleFixture({ npmRunner: async (_arguments: string[], target: string) => {
    await writePackage(target, 'rollback-package', version, { llmhub: { configSchema: [{ key: 'token', type: 'secret', label: 'Token', required: true }] } },
      version === '1.0.0' ? '' : 'await api.storage.setItem("old", "changed"); await api.storage.setItem("new", true); await api.storage.removeItem("removed")')
  } })
  try {
    await fixture.manager.installNpm({ name: 'rollback-package' })
    await fixture.manager.updateConfig('rollback-package', { token: 'fixture-secret' })
    await fixture.manager.enable('rollback-package')
    fixture.values.set('runtime-plugins:rollback-package:storage:old', { previous: true })
    fixture.values.set('runtime-plugins:rollback-package:storage:removed', 'preserved')
    const before = structuredClone(fixture.values)
    fixture.failNextWrite('runtime-plugins:npm-project')
    version = '2.0.0'
    await assert.rejects(fixture.manager.update('rollback-package'))
    assert.deepEqual(fixture.values, before)
    const record = fixture.manager.list()[0]
    assert.equal(record.enabled, true)
    assert.equal(record.manifest.version, '1.0.0')
  } finally { await fixture.close() }
})

test('scan isolates npm collisions with builtin ids and still discovers local plugins', async () => {
  const fixture = await lifecycleFixture({ builtinPlugins: () => [{ id: 'reserved-plugin', manifest: { id: 'reserved-plugin', name: 'Builtin', version: '1.0.0' }, enabled: true, status: 'enabled' }] })
  try {
    await writePackage(fixture.directory, 'collision-builtin', '1.0.0', { llmhub: { id: 'reserved-plugin' } })
    const local = join(fixture.directory, 'local-survivor')
    await mkdir(local)
    await writeFile(join(local, 'plugin.json'), JSON.stringify({ id: 'local-survivor', name: 'Local', version: '1.0.0' }))
    await writeFile(join(local, 'index.mjs'), 'export default { setup() {} }')
    fixture.values.set('runtime-plugins:local-survivor:state', { enabled: true, configuration: {} })
    await fixture.manager.scan()
    assert.equal(fixture.manager.list().find((record: any) => record.id === 'local-survivor')?.enabled, true)
  } finally { await fixture.close() }
})

test('failed initial npm persistence rolls back installed files and allows retry', async () => {
  const fixture = await lifecycleFixture({ npmRunner: async (_arguments: string[], target: string) => {
    await writePackage(target, 'retry-package', '1.0.0')
  } })
  try {
    const { readdir } = await import('node:fs/promises')
    fixture.failNextWrite('runtime-plugins:npm-project')
    await assert.rejects(fixture.manager.installNpm({ name: 'retry-package' }))
    assert.deepEqual(fixture.manager.list(), [])
    assert.deepEqual(await readdir(fixture.directory), [])
    assert.equal(fixture.values.has('runtime-plugins:npm-project'), false)
    const installed = await fixture.manager.installNpm({ name: 'retry-package' })
    assert.equal(installed[0].id, 'retry-package')
    assert.equal(installed[0].enabled, false)
  } finally { await fixture.close() }
})
