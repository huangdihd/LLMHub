import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const buildDirectory = process.env.ADAPTER_BUILD
if (!buildDirectory) throw new Error('Run through tests/run-all.sh')
const { ProviderRegistry } = require(`${buildDirectory}/core/registry.js`)
const { HookRegistry } = require(`${buildDirectory}/core/hooks.js`)
const { PluginManager } = require(`${buildDirectory}/plugins-runtime/manager.js`)

type Manifest = Record<string, unknown>

function memoryStorage() {
  const values = new Map<string, unknown>()
  return {
    values,
    async getItem(key: string) { return structuredClone(values.get(key) ?? null) },
    async setItem(key: string, value: unknown) { values.set(key, structuredClone(value)) },
    async removeItem(key: string) { values.delete(key) },
    async getKeys(prefix = '') { return [...values.keys()].filter(key => key.startsWith(prefix)) }
  }
}

function manifest(id: string, fields: Manifest = {}) {
  return { id, name: id, version: '1.0.0', engines: { llmhub: '*' }, ...fields }
}

function source(setup = '', topLevel = '') {
  return Buffer.from(`${topLevel}
export default { async setup(context) { ${setup} } };`)
}

async function writePlugin(root: string, id: string, setup = '', fields: Manifest = {}, topLevel = '') {
  const directory = path.join(root, id)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'plugin.json'), JSON.stringify(manifest(id, { entry: 'index.mjs', ...fields })))
  await writeFile(path.join(directory, 'index.mjs'), source(setup, topLevel))
  return directory
}

async function fixture() {
  // Resolve macOS /var -> /private/var before the manager's deliberate symlink checks.
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'llmhub-plugin-dependencies-'))
  const storage = memoryStorage()
  const providerRegistry = new ProviderRegistry()
  const hookRegistry = new HookRegistry()
  const packages = new Map<string, { setup: string; fields: Manifest }>()
  const npmRunner = async (_arguments: string[], target: string) => {
    const project = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'))
    for (const id of Object.keys(project.dependencies)) {
      const candidate = packages.get(id)
      assert.ok(candidate, `Missing package fixture ${id}`)
      const directory = path.join(target, 'node_modules', id)
      await mkdir(directory, { recursive: true })
      const { version = '1.0.0', ...metadata } = candidate.fields
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: id, version, type: 'module', main: 'index.mjs', llmhub: { id, engines: { llmhub: '*' }, ...metadata } }))
      await writeFile(path.join(directory, 'index.mjs'), source(candidate.setup))
    }
  }
  const manager = new PluginManager({ directory: root, storage, providerRegistry, hookRegistry, timeoutMs: 1000, npmRunner })
  return {
    root, storage, providerRegistry, manager,
    async installPackage(id: string, setup = '', fields: Manifest = {}) {
      packages.set(id, { setup, fields })
      if (manager.list().some((plugin: { id: string }) => plugin.id === id)) return manager.update(id)
      return manager.installNpm({ name: id })
    },
    async close() { await manager.shutdown(); await rm(root, { recursive: true, force: true }) }
  }
}

const exportSetup = (value: string) => `context.provide({ value: ${JSON.stringify(value)} }); context.registerRoute('GET', 'value', () => ${JSON.stringify(value)}); context.registerRoute('GET', 'api', () => context);`
const consumerSetup = `const dependency = context.require('base-plugin'); context.registerRoute('GET', 'value', () => dependency.value); context.registerRoute('GET', 'api', () => context);`
const stateSetup = `context.registerRoute('GET', 'state', async () => ({ config: context.config, stored: await context.storage.getItem('saved') }));`
const schema = [{ key: 'label', type: 'text' }, { key: 'token', type: 'secret' }]

function record(manager: InstanceType<typeof PluginManager>, id: string) {
  const found = manager.list().find((candidate: { id: string }) => candidate.id === id)
  assert.ok(found, `Expected plugin ${id}`)
  return found
}

test('dependency reload restarts consumers with fresh exports and revokes old APIs', async () => {
  const fixtureState = await fixture()
  const { root, manager } = fixtureState
  try {
    await writePlugin(root, 'base-plugin', exportSetup('before'))
    await writePlugin(root, 'consumer-plugin', consumerSetup, { dependencies: { 'base-plugin': '^1.0.0' } })
    await manager.scan()
    await assert.rejects(manager.enable('consumer-plugin'), /not enabled/)
    await manager.enable('base-plugin')
    await manager.enable('consumer-plugin')
    const oldBase = await manager.dispatchRoute('base-plugin', 'GET', 'api', {})
    const oldConsumer = await manager.dispatchRoute('consumer-plugin', 'GET', 'api', {})
    assert.equal(await manager.dispatchRoute('consumer-plugin', 'GET', 'value', {}), 'before')
    assert.deepEqual(record(manager, 'base-plugin').requiredBy, ['consumer-plugin'])
    await assert.rejects(manager.disable('base-plugin'), /consumer-plugin/)
    await assert.rejects(manager.uninstall('base-plugin'), /consumer-plugin/)
    await writePlugin(root, 'base-plugin', exportSetup('after'), { version: '1.1.0' })
    await manager.reload('base-plugin')
    assert.equal(await manager.dispatchRoute('consumer-plugin', 'GET', 'value', {}), 'after')
    assert.throws(() => oldConsumer.require('base-plugin'), /inactive/)
    assert.throws(() => oldBase.storage.setItem('late', true), /inactive/)
    assert.throws(() => oldBase.provide({ value: 'stale' }), /closed/)
    assert.throws(() => oldConsumer.registerRoute('GET', 'late', () => true), /closed/)
    await manager.disable('consumer-plugin')
    await manager.disable('base-plugin')
    await manager.uninstall('base-plugin')
    await assert.rejects(manager.enable('consumer-plugin'), /not installed/)
  } finally { await fixtureState.close() }
})

test('undeclared require fails activation and removes registrations created before the failure', async () => {
  const fixtureState = await fixture()
  const { root, manager, providerRegistry } = fixtureState
  try {
    await writePlugin(root, 'base-plugin', exportSetup('secret'))
    await writePlugin(root, 'rogue-plugin', `context.registerProvider({ id: 'local', createAdapter() {}, async fetchModels() { return [] } }); context.require('base-plugin');`)
    await manager.scan()
    await manager.enable('base-plugin')
    await assert.rejects(manager.enable('rogue-plugin'), /must be declared/)
    assert.equal(record(manager, 'rogue-plugin').enabled, false)
    assert.equal(providerRegistry.get('rogue-plugin:local'), undefined)
    assert.equal(record(manager, 'base-plugin').enabled, true)
  } finally { await fixtureState.close() }
})

test('optional dependencies return undefined when absent, disabled or incompatible without blocking activation', async () => {
  const fixtureState = await fixture()
  const { root, manager } = fixtureState
  try {
    await writePlugin(root, 'base-plugin', exportSetup('present'), { version: '2.0.0' })
    await writePlugin(root, 'compatible-plugin', exportSetup('available'))
    await writePlugin(root, 'optional-plugin', `context.registerRoute('GET', 'value', () => [context.require('missing-plugin'), context.require('base-plugin')]); context.registerRoute('GET', 'compatible', () => context.require('compatible-plugin'));`, {
      optionalDependencies: { 'missing-plugin': '*', 'base-plugin': '^1.0.0', 'compatible-plugin': '*' }
    })
    await manager.scan()
    await manager.enable('optional-plugin')
    assert.deepEqual(await manager.dispatchRoute('optional-plugin', 'GET', 'value', {}), [undefined, undefined])
    await manager.enable('base-plugin')
    assert.deepEqual(await manager.dispatchRoute('optional-plugin', 'GET', 'value', {}), [undefined, undefined])
    assert.ok(record(manager, 'optional-plugin').dependencies.every((dependency: { optional: boolean; satisfied: boolean }) => dependency.optional && !dependency.satisfied))
    assert.equal(await manager.dispatchRoute('optional-plugin', 'GET', 'compatible', {}), undefined)
    await manager.enable('compatible-plugin')
    assert.deepEqual(await manager.dispatchRoute('optional-plugin', 'GET', 'compatible', {}), { value: 'available' })
    await manager.disable('compatible-plugin')
    assert.equal(await manager.dispatchRoute('optional-plugin', 'GET', 'compatible', {}), undefined)
    await manager.disable('base-plugin')
    await manager.uninstall('base-plugin')
    assert.equal(record(manager, 'optional-plugin').enabled, true)
    assert.deepEqual(await manager.dispatchRoute('optional-plugin', 'GET', 'value', {}), [undefined, undefined])
  } finally { await fixtureState.close() }
})

test('startup orders required dependencies and isolates cycles and transitive required failures', async () => {
  const fixtureState = await fixture()
  const { root, manager, storage } = fixtureState
  try {
    await writePlugin(root, 'aa-consumer', `if (!context.require('zz-base').ready) throw new Error('wrong startup order');`, { dependencies: { 'zz-base': '*' } })
    await writePlugin(root, 'zz-base', 'context.provide({ ready: true });')
    await writePlugin(root, 'cycle-first', '', { dependencies: { 'cycle-second': '*' } })
    await writePlugin(root, 'cycle-second', '', { dependencies: { 'cycle-first': '*' } })
    await writePlugin(root, 'self-cycle', '', { dependencies: { 'self-cycle': '*' } })
    await writePlugin(root, 'failed-base', `throw new Error('intentional fixture failure');`)
    await writePlugin(root, 'failed-child', '', { dependencies: { 'failed-base': '*' } })
    await writePlugin(root, 'failed-grandchild', '', { dependencies: { 'failed-child': '*' } })
    await writePlugin(root, 'healthy-plugin')
    for (const id of await readdir(root)) await storage.setItem(`runtime-plugins:${id}:state`, { enabled: true, configuration: {} })
    await manager.scan()
    for (const id of ['aa-consumer', 'zz-base', 'healthy-plugin']) assert.equal(record(manager, id).enabled, true, id)
    for (const id of ['cycle-first', 'cycle-second', 'self-cycle']) {
      assert.equal(record(manager, id).enabled, false)
      assert.match(record(manager, id).error, /cycle/i)
      await assert.rejects(manager.enable(id), /cycle/i)
    }
    for (const id of ['failed-base', 'failed-child', 'failed-grandchild']) {
      assert.equal(record(manager, id).enabled, false)
      assert.equal(record(manager, id).status, 'error')
    }
    assert.match(record(manager, 'failed-child').error, /failed-base/)
    assert.match(record(manager, 'failed-grandchild').error, /failed-child/)
  } finally { await fixtureState.close() }
})

test('reload failure disables transitive required consumers but leaves unrelated plugins live', async () => {
  const fixtureState = await fixture()
  const { root, manager } = fixtureState
  try {
    await writePlugin(root, 'base-plugin', exportSetup('ready'))
    await writePlugin(root, 'consumer-plugin', consumerSetup, { dependencies: { 'base-plugin': '*' } })
    await writePlugin(root, 'leaf-plugin', '', { dependencies: { 'consumer-plugin': '*' } })
    await writePlugin(root, 'healthy-plugin')
    await manager.scan()
    for (const id of ['base-plugin', 'consumer-plugin', 'leaf-plugin', 'healthy-plugin']) await manager.enable(id)
    await writePlugin(root, 'base-plugin', `throw new Error('intentional reload failure');`, { version: '1.1.0' })
    await assert.rejects(manager.reload('base-plugin'), /activation failed/)
    for (const id of ['base-plugin', 'consumer-plugin', 'leaf-plugin']) {
      assert.equal(record(manager, id).enabled, false)
      assert.equal(record(manager, id).status, 'error')
    }
    assert.equal(record(manager, 'healthy-plugin').enabled, true)
    await assert.rejects(manager.dispatchRoute('consumer-plugin', 'GET', 'value', {}), /not found/)
  } finally { await fixtureState.close() }
})

for (const enabled of [true, false]) {
  test(`npm upgrade preserves configuration, storage and ${enabled ? 'enabled' : 'disabled'} state`, async () => {
    const fixtureState = await fixture()
    const { manager, storage } = fixtureState
    try {
      await fixtureState.installPackage('upgrade-plugin', stateSetup, { configSchema: schema })
      await manager.updateConfig('upgrade-plugin', { label: 'kept', token: 'private-token' })
      await storage.setItem('runtime-plugins:upgrade-plugin:storage:saved', { count: 7 })
      if (enabled) await manager.enable('upgrade-plugin')
      await fixtureState.installPackage('upgrade-plugin', stateSetup, { version: '1.1.0', configSchema: schema })
      assert.equal(record(manager, 'upgrade-plugin').manifest.version, '1.1.0')
      assert.equal(record(manager, 'upgrade-plugin').enabled, enabled)
      assert.deepEqual(manager.getConfig('upgrade-plugin'), { label: 'kept' })
      const persisted = await storage.getItem('runtime-plugins:upgrade-plugin:state') as { enabled: boolean; configuration: unknown }
      assert.equal(persisted.enabled, enabled)
      assert.deepEqual(persisted.configuration, { label: 'kept', token: 'private-token' })
      assert.deepEqual(await storage.getItem('runtime-plugins:upgrade-plugin:storage:saved'), { count: 7 })
      if (!enabled) await manager.enable('upgrade-plugin')
      assert.deepEqual(await manager.dispatchRoute('upgrade-plugin', 'GET', 'state', {}), { config: { label: 'kept', token: 'private-token' }, stored: { count: 7 } })
    } finally { await fixtureState.close() }
  })

  test(`failed upgrade restores files, configuration, storage and ${enabled ? 'enabled' : 'disabled'} state`, async () => {
    const fixtureState = await fixture()
    const { root, manager, storage } = fixtureState
    try {
      const original = source(stateSetup)
      await fixtureState.installPackage('rollback-plugin', stateSetup, { configSchema: schema })
      await manager.updateConfig('rollback-plugin', { label: 'original', token: 'secret' })
      await storage.setItem('runtime-plugins:rollback-plugin:storage:saved', 'retained')
      if (enabled) await manager.enable('rollback-plugin')
      const previousState = await storage.getItem('runtime-plugins:rollback-plugin:state')
      // Disabled updates must roll back persistence without executing replacement setup.
      const setItem = storage.setItem.bind(storage)
      let rejectNextStateWrite = !enabled
      storage.setItem = async (key: string, value: unknown) => {
        if (rejectNextStateWrite && key === 'runtime-plugins:rollback-plugin:state') {
          rejectNextStateWrite = false
          throw new Error('intentional state persistence failure')
        }
        await setItem(key, value)
      }
      await assert.rejects(fixtureState.installPackage('rollback-plugin', enabled ? `throw new Error('intentional upgrade failure');` : stateSetup, { version: '2.0.0', configSchema: schema }), /failed/i)
      assert.equal(record(manager, 'rollback-plugin').manifest.version, '1.0.0')
      assert.equal(record(manager, 'rollback-plugin').enabled, enabled)
      assert.equal(await readFile(path.join(root, 'node_modules/rollback-plugin/index.mjs'), 'utf8'), original.toString())
      assert.deepEqual(await storage.getItem('runtime-plugins:rollback-plugin:state'), previousState)
      assert.equal(await storage.getItem('runtime-plugins:rollback-plugin:storage:saved'), 'retained')
      assert.deepEqual(manager.getConfig('rollback-plugin'), { label: 'original' })
      assert.deepEqual((await readdir(path.join(root, 'node_modules'))).sort(), ['rollback-plugin'])
      if (!enabled) await manager.enable('rollback-plugin')
      assert.deepEqual(await manager.dispatchRoute('rollback-plugin', 'GET', 'state', {}), { config: { label: 'original', token: 'secret' }, stored: 'retained' })
    } finally { await fixtureState.close() }
  })
}

test('incompatible dependency upgrade rolls back provider and consumer runtimes', async () => {
  const fixtureState = await fixture()
  const { root, manager } = fixtureState
  try {
    await fixtureState.installPackage('base-plugin', exportSetup('original'))
    await manager.enable('base-plugin')
    await fixtureState.installPackage('consumer-plugin', consumerSetup, { dependencies: { 'base-plugin': '^1.0.0' } })
    await manager.enable('consumer-plugin')
    await assert.rejects(fixtureState.installPackage('base-plugin', exportSetup('incompatible'), { version: '2.0.0' }), /requires/)
    assert.equal(record(manager, 'base-plugin').manifest.version, '1.0.0')
    assert.equal(record(manager, 'base-plugin').enabled, true)
    assert.equal(record(manager, 'consumer-plugin').enabled, true)
    assert.equal(await manager.dispatchRoute('consumer-plugin', 'GET', 'value', {}), 'original')
    assert.deepEqual((await readdir(path.join(root, 'node_modules'))).sort(), ['base-plugin', 'consumer-plugin'])
  } finally { await fixtureState.close() }
})

test('scan discovers additions and reloads version changes with live consumers', async () => {
  const fixtureState = await fixture()
  const { root, manager } = fixtureState
  try {
    await writePlugin(root, 'base-plugin', exportSetup('first'))
    await writePlugin(root, 'consumer-plugin', consumerSetup, { dependencies: { 'base-plugin': '*' } })
    await manager.scan()
    await manager.enable('base-plugin')
    await manager.enable('consumer-plugin')
    await writePlugin(root, 'base-plugin', exportSetup('scanned'), { version: '1.1.0' })
    await writePlugin(root, 'new-plugin')
    await manager.scan()
    assert.equal(await manager.dispatchRoute('consumer-plugin', 'GET', 'value', {}), 'scanned')
    assert.equal(record(manager, 'new-plugin').enabled, false)
    await writePlugin(root, 'base-plugin', exportSetup('restored'), { version: '1.2.0' })
    await manager.scan()
    await manager.enable('base-plugin')
    await manager.enable('consumer-plugin')
    assert.equal(await manager.dispatchRoute('consumer-plugin', 'GET', 'value', {}), 'restored')
  } finally { await fixtureState.close() }
})

test('incompatible directory API is rejected before top-level marker execution; legacy directories warn', async () => {
  const fixtureState = await fixture()
  const { root, manager } = fixtureState
  try {
    const marker = path.join(root, 'executed-marker')
    const topLevel = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`
    await writePlugin(root, 'api-plugin', '', { engines: { llmhub: '>=999.0.0' } }, topLevel)
    await writePlugin(root, 'legacy-plugin', '', { version: 'historical-build', engines: undefined })
    await writePlugin(root, 'legacy-consumer', '', { dependencies: { 'legacy-plugin': '*' } })
    await manager.scan()
    await assert.rejects(manager.enable('api-plugin'), /plugin API/)
    await assert.rejects(readFile(marker), { code: 'ENOENT' })
    await manager.enable('legacy-plugin')
    assert.equal(record(manager, 'legacy-plugin').enabled, true)
    assert.match(record(manager, 'legacy-plugin').warnings.join('; '), /not valid semver/)
    assert.match(record(manager, 'legacy-plugin').warnings.join('; '), /compatibility is not declared/)
    await assert.rejects(manager.enable('legacy-consumer'), /historical-build/)
  } finally { await fixtureState.close() }
})

test('directory version changes reject invalid semver without replacing a live implementation', async () => {
  const fixtureState = await fixture()
  const { root, manager } = fixtureState
  try {
    await writePlugin(root, 'version-plugin', exportSetup('original'))
    await manager.scan()
    await manager.enable('version-plugin')
    await writePlugin(root, 'version-plugin', exportSetup('invalid'), { version: 'not-semver' })
    await assert.rejects(manager.reload('version-plugin'), /semver/)
    assert.equal(record(manager, 'version-plugin').manifest.version, '1.0.0')
    assert.equal(await manager.dispatchRoute('version-plugin', 'GET', 'value', {}), 'original')
  } finally { await fixtureState.close() }
})

test('disabled incompatible discoveries are marked failed without executing their entry', async () => {
  const fixtureState = await fixture()
  const { root, manager } = fixtureState
  try {
    await writePlugin(root, 'incompatible-plugin', '', { engines: { llmhub: '>=999.0.0' } }, `throw new Error('must not execute');`)
    await manager.scan()
    assert.equal(record(manager, 'incompatible-plugin').status, 'error')
    assert.match(record(manager, 'incompatible-plugin').error, /plugin API/)
    assert.equal(record(manager, 'incompatible-plugin').manifest.version, '1.0.0')
  } finally { await fixtureState.close() }
})

test('failed configuration callbacks revoke transitive required consumers and refresh optional consumers', async () => {
  const fixtureState = await fixture()
  const { root, manager } = fixtureState
  try {
    await writePlugin(root, 'base-plugin', `${exportSetup('original')} context.onConfigChange(() => { throw new Error('configuration failure'); });`, { configSchema: schema })
    await writePlugin(root, 'consumer-plugin', consumerSetup, { dependencies: { 'base-plugin': '*' } })
    await writePlugin(root, 'leaf-plugin', '', { dependencies: { 'consumer-plugin': '*' } })
    await writePlugin(root, 'optional-plugin', `const dependency = context.require('base-plugin'); context.registerRoute('GET', 'value', () => dependency?.value ?? 'absent');`, { optionalDependencies: { 'base-plugin': '*' } })
    await manager.scan()
    for (const id of ['base-plugin', 'consumer-plugin', 'leaf-plugin', 'optional-plugin']) await manager.enable(id)
    const oldConsumer = await manager.dispatchRoute('consumer-plugin', 'GET', 'api', {})
    await assert.rejects(manager.updateConfig('base-plugin', { label: 'changed' }), /configuration callback failed/)
    for (const id of ['base-plugin', 'consumer-plugin', 'leaf-plugin']) {
      assert.equal(record(manager, id).enabled, false)
      assert.equal(record(manager, id).status, 'error')
    }
    assert.throws(() => oldConsumer.require('base-plugin'), /inactive/)
    assert.equal(await manager.dispatchRoute('optional-plugin', 'GET', 'value', {}), 'absent')
  } finally { await fixtureState.close() }
})

test('failed upgrade restores storage mutations made by candidate setup', async () => {
  const fixtureState = await fixture()
  const { manager, storage } = fixtureState
  try {
    await fixtureState.installPackage('storage-plugin', stateSetup)
    await storage.setItem('runtime-plugins:storage-plugin:storage:saved', 'original')
    await storage.setItem('runtime-plugins:storage-plugin:storage:deleted', 'retained')
    await manager.enable('storage-plugin')
    await assert.rejects(fixtureState.installPackage('storage-plugin', `await context.storage.setItem('saved', 'corrupted'); await context.storage.removeItem('deleted'); await context.storage.setItem('created', true); throw new Error('upgrade failure');`, { version: '2.0.0' }), /failed/)
    assert.equal(await storage.getItem('runtime-plugins:storage-plugin:storage:saved'), 'original')
    assert.equal(await storage.getItem('runtime-plugins:storage-plugin:storage:deleted'), 'retained')
    assert.equal(await storage.getItem('runtime-plugins:storage-plugin:storage:created'), null)
  } finally { await fixtureState.close() }
})
test('directory reload observes changes in relative imported modules', async () => {
  const fixtureState = await fixture()
  const { root, manager } = fixtureState
  try {
    const directory = await writePlugin(root, 'relative-plugin', 'context.provide({ value }); context.registerRoute("GET", "value", () => value);', {}, 'import { value } from "./helper.mjs";')
    await writeFile(path.join(directory, 'helper.mjs'), 'export const value = "before";')
    await manager.scan()
    await manager.enable('relative-plugin')
    await writeFile(path.join(directory, 'helper.mjs'), 'export const value = "after";')
    await writePlugin(root, 'relative-plugin', 'context.provide({ value }); context.registerRoute("GET", "value", () => value);', { version: '1.1.0' }, 'import { value } from "./helper.mjs";')
    await manager.reload('relative-plugin')
    assert.equal(await manager.dispatchRoute('relative-plugin', 'GET', 'value', {}), 'after')
  } finally { await fixtureState.close() }
})

for (const operation of ['reload', 'scan'] as const) {
  test(`disabled local ${operation} refreshes metadata without executing top-level code or setup`, async () => {
    const fixtureState = await fixture()
    const { root, manager, storage } = fixtureState
    try {
      const marker = path.join(root, 'execution-marker')
      const topLevel = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`
      await writePlugin(root, 'disabled-plugin', `throw new Error('setup must not execute')`, {}, topLevel)
      await manager.scan()
      await assert.rejects(readFile(marker), { code: 'ENOENT' })
      await manager.updateConfig('disabled-plugin', {})
      await storage.setItem('runtime-plugins:disabled-plugin:storage:saved', 'retained')
      await writePlugin(root, 'disabled-plugin', `throw new Error('setup must not execute')`, { version: '1.1.0', configSchema: [{ key: 'token', type: 'secret', required: true }] }, topLevel)
      if (operation === 'reload') await manager.reload('disabled-plugin')
      else await manager.scan()
      assert.equal(record(manager, 'disabled-plugin').enabled, false)
      assert.equal(record(manager, 'disabled-plugin').manifest.version, '1.1.0')
      assert.equal(record(manager, 'disabled-plugin').status, 'disabled')
      await assert.rejects(readFile(marker), { code: 'ENOENT' })
      assert.equal(await storage.getItem('runtime-plugins:disabled-plugin:storage:saved'), 'retained')
    } finally { await fixtureState.close() }
  })
}

test('reload snapshots keep nested lazy imports and assets until stop; initial paths stay unchanged', async () => {
  const fixtureState = await fixture()
  const { root, manager } = fixtureState
  try {
    const directory = await writePlugin(root, 'snapshot-plugin', `
      context.registerRoute('GET', 'url', () => import.meta.url);
      context.registerRoute('GET', 'asset', () => readFile(new URL('./assets/value.txt', import.meta.url), 'utf8'));
      context.registerRoute('GET', 'lazy', async () => (await import('./assets/helper.mjs')).value);
    `, {}, `import { readFile } from 'node:fs/promises';`)
    await mkdir(path.join(directory, 'assets'))
    await writeFile(path.join(directory, 'assets/value.txt'), 'snapshot asset')
    await writeFile(path.join(directory, 'assets/helper.mjs'), 'export const value = "snapshot helper"')
    await manager.scan()
    await manager.enable('snapshot-plugin')
    assert.equal(path.dirname(new URL(await manager.dispatchRoute('snapshot-plugin', 'GET', 'url', {})).pathname), directory)
    await manager.reload('snapshot-plugin')
    const generationURL = new URL(await manager.dispatchRoute('snapshot-plugin', 'GET', 'url', {}))
    assert.notEqual(path.dirname(generationURL.pathname), directory)
    await writeFile(path.join(directory, 'assets/value.txt'), 'changed source')
    await writeFile(path.join(directory, 'assets/helper.mjs'), 'export const value = "changed helper"')
    assert.equal(await manager.dispatchRoute('snapshot-plugin', 'GET', 'asset', {}), 'snapshot asset')
    assert.equal(await manager.dispatchRoute('snapshot-plugin', 'GET', 'lazy', {}), 'snapshot helper')
    await manager.disable('snapshot-plugin')
    await assert.rejects(readFile(generationURL), { code: 'ENOENT' })
  } finally { await fixtureState.close() }
})

for (const failure of ['import', 'setup', 'timeout']) {
  test(`reload snapshot is removed after ${failure} failure`, async () => {
    const fixtureState = await fixture()
    const { root, manager } = fixtureState
    const globals = globalThis as typeof globalThis & { pluginGenerationURL?: string }
    try {
      await writePlugin(root, 'failure-snapshot')
      await manager.scan()
      await manager.enable('failure-snapshot')
      const capture = 'globalThis.pluginGenerationURL = import.meta.url;'
      const setup = failure === 'setup' ? `${capture} throw new Error('setup failure')` : ''
      let imports = ''
      if (failure === 'import') imports = `${capture} throw new Error('import failure');`
      if (failure === 'timeout') imports = `${capture} await new Promise(resolve => setTimeout(resolve, 1150));`
      await writePlugin(root, 'failure-snapshot', setup, {}, imports)
      await assert.rejects(manager.reload('failure-snapshot'), /activation failed/)
      assert.ok(globals.pluginGenerationURL)
      await assert.rejects(readFile(new URL(globals.pluginGenerationURL)), { code: 'ENOENT' })
      if (failure === 'timeout') {
        await new Promise(resolve => setTimeout(resolve, 250))
        await assert.rejects(readFile(new URL(globals.pluginGenerationURL)), { code: 'ENOENT' })
        assert.equal(record(manager, 'failure-snapshot').enabled, false)
      }
    } finally { delete globals.pluginGenerationURL; await fixtureState.close() }
  })
}

test('generation rejects symlinked assets and removes incomplete snapshots', async () => {
  const { createModuleGeneration } = require(`${buildDirectory}/plugins-runtime/module-generation.js`)
  const fixtureState = await fixture()
  try {
    const directory = await writePlugin(fixtureState.root, 'symlink-snapshot')
    await symlink(path.join(directory, 'index.mjs'), path.join(directory, 'linked.mjs'))
    const temporaryRoot = await realpath(tmpdir())
    const before = (await readdir(temporaryRoot)).filter(name => name.startsWith('llmhub-plugin-generation-')).sort()
    await assert.rejects(createModuleGeneration(directory), /symlinks/)
    const after = (await readdir(temporaryRoot)).filter(name => name.startsWith('llmhub-plugin-generation-')).sort()
    assert.deepEqual(after, before)
  } finally { await fixtureState.close() }
})
