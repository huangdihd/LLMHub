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
const { validateContributions } = require(`${build}/plugins-runtime/manifest.js`)
const { removeRecordContributions, recordValuesKey } = require(`${build}/plugins-runtime/record-values.js`)
const { ProviderRegistry } = require(`${build}/core/registry.js`)
const { HookRegistry } = require(`${build}/core/hooks.js`)
const { AuthStore } = require(`${build}/stores/auth.store.js`)
const { ProviderStore } = require(`${build}/stores/provider.store.js`)
const runtime = require(`${build}/plugins-runtime/index.js`)
const recordEndpoint = require(`${build}/api/hub/plugin-contributions/[...path].js`).default
const listEndpoint = require(`${build}/api/hub/plugin-contributions/index.get.js`).default
const metricsEndpoint = require(`${build}/api/hub/plugin-contributions/metrics.get.js`).default

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
const fields = [{ key: 'note', type: 'text', default: 'default' }, { key: 'token', type: 'secret' }, { key: 'count', type: 'number' }]
async function createFixture(setup = '') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'contributions-test-'))
  const storage = memoryStorage()
  const records: Record<string, string[]> = { models: ['provider/model'], apiKeys: ['key-id'], providers: ['provider'] }
  const manager = new PluginManager({ directory: root, storage, providerRegistry: new ProviderRegistry(), hookRegistry: new HookRegistry(), timeoutMs: 40, listRecordIds: async (location: string) => records[location] ?? [] })
  async function install(id: string, extra = setup) {
    const directory = join(root, id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', entry: 'index.mjs', contributes: { models: fields, apiKeys: fields, providers: fields, metrics: ['good', 'bad', 'slow', 'invalid', 'missing'].map(key => ({ key, label: key })) } }))
    await writeFile(join(directory, 'index.mjs'), `export default { setup(context) {
      context.registerRoute('GET', 'values', () => context.getAllRecordValues('apiKeys'));
      context.registerMetric('good', () => 7);
      context.registerMetric('bad', () => { throw new Error('private detail') });
      context.registerMetric('slow', () => new Promise(() => {}));
      context.registerMetric('invalid', () => Infinity);
      ${extra}
    } }`)
    await manager.scan()
    await manager.enable(id)
  }
  return { root, manager, storage, records, install, async close() { await manager.shutdown(); await rm(root, { recursive: true, force: true }) } }
}

test('contribution manifests reject invalid locations, duplicate IDs, secrets in lists and unsafe panel paths', () => {
  for (const input of [null, [], { unknown: [] }, { models: [{ key: '__proto__', type: 'text' }] },
    { apiKeys: [{ key: 'secret', type: 'secret', showInList: true }] }, { models: [{ key: 'text', type: 'text', showInList: true }] },
    { metrics: [{ key: 'same', label: 'one' }, { key: 'same', label: 'two' }] },
    { metrics: [{ key: 'ok', label: 'ok', value: 'injected' }] },
    { panels: [{ id: 'panel', title: 'Panel', location: 'page', page: '../outside.html' }] },
    { panels: [{ id: 'panel', title: 'Panel', location: 'unknown', page: 'panel.html' }] },
    { navigation: [{ panel: 'missing', label: 'Missing' }] },
    { models: [{ key: 'option', type: 'select', options: [{ label: 'Bad', value: Infinity }] }] }
  ]) assert.throws(() => validateContributions(input))
  const input = { apiKeys: [{ key: 'team', type: 'text', showInList: true }], panels: [{ id: 'panel', title: 'Panel', location: 'page', page: 'ui/panel.html' }], navigation: [{ panel: 'panel', label: 'Panel' }] }
  assert.deepEqual(validateContributions(input), input)
})

test('record values are isolated, validated, secret-redacted, and durable across disable/reload', async () => {
  const fixture = await createFixture()
  const { manager, storage } = fixture
  try {
    await fixture.install('first-plugin')
    await fixture.install('second-plugin')
    assert.equal(manager.listContributions().length, 2)
    assert.deepEqual(await manager.updateRecordValues('first-plugin', 'apiKeys', 'key-id', { note: 'first', token: 'private', count: 2 }), { note: 'first', count: 2 })
    assert.deepEqual(await manager.getRecordValues('second-plugin', 'apiKeys', 'key-id'), { note: 'default' })
    await manager.updateRecordValues('first-plugin', 'apiKeys', 'key-id', { token: '********' })
    const values = await manager.dispatchRoute('first-plugin', 'GET', 'values', {})
    assert.equal(values['key-id'].token, 'private')
    values['key-id'].note = 'mutated'
    assert.equal((await manager.getRecordValues('first-plugin', 'apiKeys', 'key-id')).note, 'first')
    for (const input of [{ unknown: true }, { count: '2' }, { count: Infinity }, [], null]) await assert.rejects(manager.updateRecordValues('first-plugin', 'apiKeys', 'key-id', input))
    await assert.rejects(manager.getRecordValues('first-plugin', 'unknown', 'key-id'))
    await assert.rejects(manager.updateRecordValues('first-plugin', 'apiKeys', 'missing', {}))
    assert.deepEqual(await manager.getRecordValues('first-plugin', 'apiKeys', 'missing'), { note: 'default' })
    await assert.rejects(manager.getRecordValues('first-plugin', 'apiKeys', '__proto__'))
    await manager.disable('first-plugin')
    assert.equal(manager.listContributions().length, 1)
    await assert.rejects(manager.getRecordValues('first-plugin', 'apiKeys', 'key-id'))
    await manager.enable('first-plugin')
    await manager.reload('first-plugin')
    assert.equal((await manager.getRecordValues('first-plugin', 'apiKeys', 'key-id')).note, 'first')
    await manager.uninstall('first-plugin')
    assert.equal(storage.values.has(recordValuesKey('first-plugin')), false)
    assert.equal(manager.listContributions()[0].id, 'second-plugin')
  } finally { await fixture.close() }
})

test('metric failures are bounded, isolated and generic; disabled metrics disappear', async () => {
  const fixture = await createFixture()
  try {
    await fixture.install('metric-plugin')
    const metrics = await fixture.manager.getMetrics()
    assert.equal(metrics[0].value, 7)
    assert.equal(metrics[0].error, undefined)
    for (const metric of metrics.slice(1)) assert.deepEqual({ value: metric.value, error: metric.error }, { value: null, error: 'Metric unavailable' })
    assert.equal(JSON.stringify(metrics).includes('private detail'), false)
    await fixture.manager.disable('metric-plugin')
    assert.deepEqual(await fixture.manager.getMetrics(), [])
  } finally { await fixture.close() }
})

test('listener failure reports persisted values without leaking errors and reload remains usable', async () => {
  const fixture = await createFixture(`context.onRecordValuesChange(change => { if (change.values.note === 'fail') throw new Error('secret failure'); });`)
  try {
    await fixture.install('listener-plugin')
    await assert.rejects(fixture.manager.updateRecordValues('listener-plugin', 'apiKeys', 'key-id', { note: 'fail' }), /saved, but a change listener failed/)
    assert.equal((await fixture.manager.getRecordValues('listener-plugin', 'apiKeys', 'key-id')).note, 'fail')
    await fixture.manager.reload('listener-plugin')
    assert.deepEqual(await fixture.manager.updateRecordValues('listener-plugin', 'apiKeys', 'key-id', { note: 'pass' }), { note: 'pass' })
  } finally { await fixture.close() }
})

test('record deletion purges every plugin namespace, provider-owned models, and not private storage', async () => {
  const storage = memoryStorage()
  for (const id of ['first', 'second']) await storage.setItem(recordValuesKey(id), { apiKeys: { key: { token: 'secret' } }, providers: { provider: { note: 'old' } }, models: { 'provider/model': { note: 'old' }, 'provider-other/model': { note: 'keep' } } })
  await storage.setItem('runtime-plugins:first:storage:private', 'keep')
  await removeRecordContributions(storage, 'apiKeys', 'key')
  await removeRecordContributions(storage, 'providers', 'provider')
  for (const id of ['first', 'second']) assert.deepEqual(await storage.getItem(recordValuesKey(id)), { apiKeys: {}, providers: {}, models: { 'provider-other/model': { note: 'keep' } } })
  assert.equal(await storage.getItem('runtime-plugins:first:storage:private'), 'keep')
})

test('actual key revocation and provider deletion remove contribution values', async () => {
  const storage = memoryStorage()
  const previous = (globalThis as any).useStorage
  ;(globalThis as any).useStorage = () => storage
  try {
    const auth = new AuthStore()
    const { record } = await auth.generateKey('test')
    await storage.setItem('providers:provider', { name: 'provider' })
    await storage.setItem(recordValuesKey('plugin'), { apiKeys: { [record.id]: { token: 'secret' } }, providers: { provider: { note: 'old' } }, models: { 'provider/model': { note: 'old' } } })
    assert.equal(await auth.revokeKey(record.id), true)
    assert.equal(await new ProviderStore().delete('provider'), true)
    assert.deepEqual(await storage.getItem(recordValuesKey('plugin')), { apiKeys: {}, providers: {}, models: {} })
    assert.equal(await auth.revokeKey(record.id), false)
  } finally { (globalThis as any).useStorage = previous }
})

test('management endpoints decode model IDs once, enforce verbs and map safe errors', async () => {
  const fixture = await createFixture()
  const previous = runtime.getPluginManager
  runtime.getPluginManager = () => fixture.manager
  const event = (path: string, method = 'GET') => ({ context: { params: { path } }, node: { req: { method } } })
  try {
    await fixture.install('route-plugin')
    assert.equal(listEndpoint({})[0].id, 'route-plugin')
    assert.equal((await metricsEndpoint({}))[0].value, 7)
    assert.deepEqual(await recordEndpoint(event('route-plugin/models/provider%2Fmodel')), { note: 'default' })
    assert.deepEqual(await recordEndpoint(event('route-plugin/models/provider%252Fmodel')), { note: 'default' })
    await assert.rejects(recordEndpoint(event('route-plugin/models/%ZZ')), { statusCode: 400 })
    await assert.rejects(recordEndpoint(event('route-plugin/models/provider/model')), { statusCode: 404 })
    await assert.rejects(recordEndpoint(event('route-plugin/models/provider%2Fmodel', 'DELETE')), { statusCode: 405 })
    await fixture.manager.disable('route-plugin')
    await assert.rejects(recordEndpoint(event('route-plugin/models/provider%2Fmodel')), { statusCode: 404 })
  } finally { runtime.getPluginManager = previous; await fixture.close() }
})
