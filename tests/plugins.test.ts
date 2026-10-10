import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const buildDirectory = process.env.ADAPTER_BUILD
if (!buildDirectory) throw new Error('Run through tests/run-all.sh')
const { ProviderRegistry } = require(`${buildDirectory}/core/registry.js`)
const { HookRegistry } = require(`${buildDirectory}/core/hooks.js`)
const { PluginManager } = require(`${buildDirectory}/plugins-runtime/manager.js`)
const { safePath, validateConfiguration } = require(`${buildDirectory}/plugins-runtime/manifest.js`)

async function temporaryDirectory() {
  const parent = path.resolve('.programmer/tmp')
  await mkdir(parent, { recursive: true })
  return mkdtemp(path.join(parent, 'plugins-test-'))
}

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

async function writePlugin(root: string, id: string, setup: string, manifest: Record<string, unknown> = {}) {
  const directory = path.join(root, id)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', entry: 'index.mjs', ...manifest }))
  await writeFile(path.join(directory, 'index.mjs'), `export default { async setup(context) { ${setup} } }`)
  return directory
}

async function fixture(options: Record<string, unknown> = {}) {
  const root = await temporaryDirectory()
  const storage = memoryStorage()
  const providerRegistry = new ProviderRegistry()
  const hookRegistry = new HookRegistry()
  const manager = new PluginManager({ directory: root, storage, providerRegistry, hookRegistry, timeoutMs: 100, cleanupTimeoutMs: 50, ...options })
  return { root, storage, providerRegistry, hookRegistry, manager }
}

const registrations = `
  context.registerProvider({ id: 'local', createAdapter() { return {} }, async fetchModels() { return [] }, connectionSchema: [{ key: 'token', type: 'secret' }] });
  context.registerHook({ id: 'local', onRequest(request) { return { ...request, model: 'changed' } } });
  context.registerRoute('GET', '/status', () => context.config);
`

test('runtime namespaces providers, hooks, routes and storage and unloads only its own registrations', async () => {
  const { root, manager, storage, providerRegistry, hookRegistry } = await fixture()
  try {
    for (const id of ['first-plugin', 'second-plugin']) await writePlugin(root, id, `${registrations} await context.storage.setItem('value', '${id}');`)
    await manager.scan()
    await manager.enable('first-plugin')
    await manager.enable('second-plugin')
    assert.deepEqual(providerRegistry.list().map((definition: { id: string }) => definition.id), ['first-plugin:local', 'second-plugin:local'])
    assert.deepEqual(providerRegistry.get('first-plugin:local').secretConnectionFields, ['extra.token'])
    assert.equal(storage.values.get('runtime-plugins:first-plugin:storage:value'), 'first-plugin')
    assert.equal(storage.values.get('runtime-plugins:second-plugin:storage:value'), 'second-plugin')
    assert.deepEqual(await manager.dispatchRoute('first-plugin', 'GET', 'status', {}), {})
    await manager.disable('first-plugin')
    assert.equal(providerRegistry.get('first-plugin:local'), undefined)
    assert.ok(providerRegistry.get('second-plugin:local'))
    await assert.rejects(manager.dispatchRoute('first-plugin', 'GET', 'status', {}))
    await manager.uninstall('second-plugin')
    assert.equal(storage.values.has('runtime-plugins:second-plugin:storage:value'), false)
    assert.equal((await hookRegistry.request({ model: 'original' }, {})).model, 'original')
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('config secrets are omitted, retained on masked updates and persisted across managers', async () => {
  const { root, manager, storage, providerRegistry, hookRegistry } = await fixture()
  try {
    await writePlugin(root, 'config-plugin', registrations, { configSchema: [{ key: 'token', type: 'secret', required: true }, { key: 'count', type: 'number', default: 2 }] })
    await manager.scan()
    await assert.rejects(manager.enable('config-plugin'))
    await manager.updateConfig('config-plugin', { token: 'private-token' })
    await manager.enable('config-plugin')
    assert.deepEqual(await manager.updateConfig('config-plugin', { token: '********', count: 3 }), { count: 3 })
    assert.deepEqual(await manager.dispatchRoute('config-plugin', 'GET', 'status', {}), { token: 'private-token', count: 3 })
    assert.equal(JSON.stringify(manager.list()).includes('private-token'), false)
    await manager.shutdown()
    const restarted = new PluginManager({ directory: root, storage, providerRegistry, hookRegistry })
    try { await restarted.scan(); assert.equal(restarted.list()[0].enabled, true); assert.deepEqual(restarted.getConfig('config-plugin'), { count: 3 }) }
    finally { await restarted.shutdown() }
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('failed and timed-out setup rolls back registrations and revokes late registration', async () => {
  const { root, manager, providerRegistry } = await fixture({ timeoutMs: 30 })
  try {
    await writePlugin(root, 'failure-plugin', `${registrations} throw new Error('secret-value');`)
    await writePlugin(root, 'timeout-plugin', `${registrations} await new Promise(resolve => setTimeout(resolve, 90)); try { context.registerRoute('GET', 'late', () => true) } catch {} return () => import('node:fs/promises').then(files => files.writeFile(${JSON.stringify(path.join(root, 'late-cleanup'))}, 'done'));`)
    await manager.scan()
    for (const id of ['failure-plugin', 'timeout-plugin']) {
      await assert.rejects(manager.enable(id), error => !String(error).includes('secret-value'))
      assert.equal(providerRegistry.get(`${id}:local`), undefined)
    }
    await new Promise(resolve => setTimeout(resolve, 130))
    assert.equal(await readFile(path.join(root, 'late-cleanup'), 'utf8'), 'done')
    await assert.rejects(manager.dispatchRoute('timeout-plugin', 'GET', 'late', {}))
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('configuration listener failures deactivate and cleanup timeouts do not strand registrations', async () => {
  const { root, manager, storage, providerRegistry } = await fixture()
  try {
    await writePlugin(root, 'listener-plugin', `${registrations} context.onConfigChange(() => { throw new Error('private-value') }); return () => new Promise(() => {});`)
    await manager.scan(); await manager.enable('listener-plugin')
    await assert.rejects(manager.updateConfig('listener-plugin', {}))
    assert.equal(manager.list()[0].enabled, false)
    assert.equal(providerRegistry.list().length, 0)
    assert.equal((storage.values.get('runtime-plugins:listener-plugin:state') as { enabled: boolean }).enabled, false)
    assert.equal(JSON.stringify(manager.list()).includes('private-value'), false)
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('paths reject traversal and ancestor symlinks before creating plugin directories', async () => {
  const root = await temporaryDirectory()
  try {
    await mkdir(path.join(root, 'actual'))
    await mkdir(path.join(root, 'actual', 'nested'))
    await symlink(path.join(root, 'actual'), path.join(root, 'alias'))
    await assert.rejects(safePath(root, '../outside'))
    await assert.rejects(safePath(root, 'alias/nested'))
    await assert.rejects(safePath(path.join(root, 'alias', 'nested')))
    const manager = new PluginManager({ directory: path.join(root, 'alias', 'new-parent', 'plugins'), storage: memoryStorage(), providerRegistry: new ProviderRegistry(), hookRegistry: new HookRegistry() })
    await assert.rejects(manager.scan())
    const { readdir } = await import('node:fs/promises')
    assert.deepEqual(await readdir(path.join(root, 'actual')), ['nested'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('invalid discovered manifests cannot be activated by their placeholder records', async () => {
  const { root, manager, providerRegistry } = await fixture()
  try {
    await writePlugin(root, 'invalid-plugin', registrations, { id: 'different-plugin' })
    await manager.scan()
    assert.equal(manager.list()[0].status, 'error')
    await assert.rejects(manager.enable('invalid-plugin'))
    assert.equal(providerRegistry.list().length, 0)
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('install rejects missing setup, duplicate ids and invalid uploads; valid uploads activate', async () => {
  const { root, manager } = await fixture()
  try {
    const manifest = `export const manifest = { id: 'upload-plugin', name: 'Upload', version: '1' };`
    await assert.rejects(manager.install(Buffer.from(manifest)))
    assert.equal(manager.list().length, 0)
    await assert.rejects(manager.install(Buffer.alloc(0)))
    const source = Buffer.from(`${manifest} export default { setup(context) { context.registerRoute('GET', 'status', () => 'ready') } };`)
    assert.equal((await manager.install(source)).status, 'installed')
    await assert.rejects(manager.install(source))
    await manager.enable('upload-plugin')
    assert.equal(await manager.dispatchRoute('upload-plugin', 'GET', 'status', {}), 'ready')
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('registry notification failures still run plugin cleanup', async () => {
  let failNotification = false
  const { root, manager, providerRegistry } = await fixture({ onRegistryChange() { if (failNotification) throw new Error('notification failed') } })
  try {
    const marker = path.join(root, 'cleanup-marker')
    await writePlugin(root, 'cleanup-plugin', `${registrations} return () => import('node:fs/promises').then(files => files.writeFile(${JSON.stringify(marker)}, 'done'));`)
    await manager.scan(); await manager.enable('cleanup-plugin')
    failNotification = true
    await manager.disable('cleanup-plugin').catch(() => {})
    assert.equal(providerRegistry.list().length, 0)
    assert.equal(await readFile(marker, 'utf8'), 'done')
  } finally { failNotification = false; await manager.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('reload persistence failures roll back running registrations', async () => {
  const { root, manager, storage, providerRegistry } = await fixture()
  try {
    await writePlugin(root, 'reload-plugin', registrations)
    await manager.scan(); await manager.enable('reload-plugin')
    storage.setItem = async () => { throw new Error('storage unavailable') }
    await assert.rejects(manager.reload('reload-plugin'))
    assert.equal(manager.list()[0].enabled, false)
    assert.equal(providerRegistry.list().length, 0)
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('configuration does not inherit values from Object.prototype', () => {
  assert.deepEqual(validateConfiguration([{ key: 'toString', type: 'text' }], {}), {})
})

test('reload replaces routes and shutdown removes registrations without disabling persisted state', async () => {
  const { root, manager, storage, providerRegistry } = await fixture()
  try {
    const directory = await writePlugin(root, 'reload-plugin', registrations)
    await manager.scan(); await manager.enable('reload-plugin')
    await writeFile(path.join(directory, 'index.mjs'), `export default { setup(context) { context.registerRoute('GET', 'updated', () => 'new-generation') } }`)
    await manager.reload('reload-plugin')
    await assert.rejects(manager.dispatchRoute('reload-plugin', 'GET', 'status', {}))
    assert.equal(await manager.dispatchRoute('reload-plugin', 'GET', 'updated', {}), 'new-generation')
    assert.equal(providerRegistry.list().length, 0)
    await manager.shutdown()
    assert.equal((storage.values.get('runtime-plugins:reload-plugin:state') as { enabled: boolean }).enabled, true)
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('UI assets stay inside their declared directory and reject symlinks and encoded paths', async () => {
  const { root, manager } = await fixture()
  try {
    const directory = await writePlugin(root, 'page-plugin', '', { ui: { page: 'public/index.html' } })
    await mkdir(path.join(directory, 'public'))
    await writeFile(path.join(directory, 'public', 'index.html'), '<h1>Plugin</h1>')
    await writeFile(path.join(directory, 'private.json'), '{"secret":true}')
    await symlink(path.join(directory, 'private.json'), path.join(directory, 'public', 'linked.json'))
    await manager.scan(); await manager.enable('page-plugin')
    assert.equal(await manager.resolvePage('page-plugin', ''), path.join(directory, 'public', 'index.html'))
    for (const asset of ['private.json', 'public/../private.json', 'public/%2e%2e/private.json', 'public/linked.json', 'index.mjs']) {
      await assert.rejects(manager.resolvePage('page-plugin', asset))
    }
    await manager.disable('page-plugin')
    await assert.rejects(manager.resolvePage('page-plugin', 'public/index.html'))
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('invalid storage keys and foreign registration namespaces roll back setup', async () => {
  const { root, manager, providerRegistry, storage } = await fixture()
  try {
    await writePlugin(root, 'storage-plugin', `${registrations} await context.storage.setItem('../other/state', 'bad');`)
    await writePlugin(root, 'namespace-plugin', `context.registerProvider({ id: 'other:local', createAdapter() {}, async fetchModels() { return [] } });`)
    await manager.scan()
    for (const id of ['storage-plugin', 'namespace-plugin']) await assert.rejects(manager.enable(id))
    assert.equal(providerRegistry.list().length, 0)
    assert.equal(storage.values.size, 0)
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('install evaluation timeouts remove staging directories and do not poison the install queue', async () => {
  const { root, manager } = await fixture({ timeoutMs: 30 })
  try {
    await assert.rejects(manager.install(Buffer.from('await new Promise(() => {});')))
    const { readdir } = await import('node:fs/promises')
    assert.deepEqual(await readdir(root), [])
    await manager.install(Buffer.from(`export const manifest = { id: 'after-timeout', name: 'After', version: '1' }; export default { setup() {} };`))
    assert.equal(manager.list()[0].id, 'after-timeout')
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('failed install persistence rolls back the directory and allows retry', async () => {
  const { root, manager, storage } = await fixture()
  const save = storage.setItem
  try {
    const source = Buffer.from(`export const manifest = { id: 'retry-plugin', name: 'Retry', version: '1' }; export default { setup() {} };`)
    storage.setItem = async () => { throw new Error('storage unavailable') }
    await assert.rejects(manager.install(source))
    assert.deepEqual(manager.list(), [])
    const { readdir } = await import('node:fs/promises')
    assert.deepEqual(await readdir(root), [])
    storage.setItem = save
    assert.equal((await manager.install(source)).id, 'retry-plugin')
  } finally { storage.setItem = save; await manager.shutdown(); await rm(root, { recursive: true, force: true }) }
})
