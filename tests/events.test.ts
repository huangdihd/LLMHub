import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const require = createRequire(import.meta.url)
const buildDirectory = process.env.ADAPTER_BUILD
if (!buildDirectory) throw new Error('Run through tests/run-all.sh')
const { EventRegistry } = require(`${buildDirectory}/core/events.js`)
const { validateManifest, validatePackageManifest } = require(`${buildDirectory}/plugins-runtime/manifest.js`)
const { BuiltinPluginHost } = require(`${buildDirectory}/../builtin/host.js`)
const { HookRegistry } = require(`${buildDirectory}/core/hooks.js`)
const { ProviderRegistry } = require(`${buildDirectory}/core/registry.js`)

const manifest = { id: 'event-test', name: 'Events', version: '1.0.0', events: [{ name: 'changed', description: 'State changed' }] }

test('events preserve priority and equal-priority order while isolating nested data and errors', async () => {
  const events = new EventRegistry()
  const order: string[] = []
  const payload = { nested: { value: 1 }, error: new Error('original') }
  events.subscribe('second', 'event-test:changed', (copy: typeof payload) => {
    order.push('second')
    assert.equal(copy.nested.value, 1)
    assert.equal(copy.error.message, 'original')
  })
  events.subscribe('third', 'event-test:changed', () => { order.push('third') })
  events.subscribe('first', 'event-test:changed', (copy: typeof payload) => {
    order.push('first')
    copy.nested.value = 99
    assert.equal(copy.error, payload.error)
    assert.equal(Object.isFrozen(copy.error), true)
    assert.throws(() => { copy.error.message = 'mutated' }, TypeError)
  }, -1)
  await events.emit('event-test:changed', payload)
  assert.deepEqual(order, ['first', 'second', 'third'])
  assert.equal(payload.nested.value, 1)
  assert.equal(payload.error.message, 'original')
})

test('custom error properties and causes retain identity and are deeply frozen', async () => {
  const events = new EventRegistry()
  const cause = new Error('upstream')
  const error = Object.assign(new Error('request failed', { cause }), {
    status: 429,
    details: { retry: { seconds: 3 }, labels: ['rate-limit'] }
  })
  Object.defineProperty(error, 'internal', { value: { code: 'LIMIT' }, enumerable: false })
  const received: typeof error[] = []
  events.subscribe('first', 'event-test:changed', (payload: { error: typeof error }) => {
    received.push(payload.error)
  })
  events.subscribe('second', 'event-test:changed', (payload: { error: typeof error }) => {
    received.push(payload.error)
  })
  await events.emit('event-test:changed', { error })
  assert.equal(received.length, 2)
  for (const value of received) {
    assert.equal(value, error)
    assert.equal(value.cause, cause)
    assert.equal(value.status, 429)
    assert.deepEqual(value.details, { retry: { seconds: 3 }, labels: ['rate-limit'] })
    const internal = Object.getOwnPropertyDescriptor(value, 'internal')!
    assert.equal(internal.enumerable, false)
    assert.deepEqual(internal.value, { code: 'LIMIT' })
    for (const frozen of [value, cause, value.details, value.details.retry, value.details.labels, internal.value]) {
      assert.equal(Object.isFrozen(frozen), true)
    }
    assert.throws(() => { value.status = 500 }, TypeError)
    assert.throws(() => { value.details.retry.seconds = 9 }, TypeError)
    assert.throws(() => { value.details.labels.push('changed') }, TypeError)
    assert.throws(() => { cause.message = 'changed' }, TypeError)
  }
})

test('listener throws, rejects and timeouts are logged without rejecting emission or stopping delivery', async () => {
  const events = new EventRegistry(10)
  const failures: unknown[][] = []
  const original = console.error
  console.error = (...values: unknown[]) => { failures.push(values) }
  let delivered = false
  try {
    events.subscribe('thrower', 'event-test:changed', () => { throw new Error('synchronous') })
    events.subscribe('rejecter', 'event-test:changed', async () => { throw new Error('asynchronous') })
    events.subscribe('stalled', 'event-test:changed', () => new Promise(() => {}))
    events.subscribe('last', 'event-test:changed', () => { delivered = true })
    await events.emit('event-test:changed', {})
    assert.equal(delivered, true)
    assert.equal(failures.length, 3)
  } finally { console.error = original }
})

test('unsubscribe is idempotent and cancels listeners already in the delivery snapshot', async () => {
  const events = new EventRegistry()
  let delivered = false
  let unsubscribe: () => void
  events.subscribe('first', 'event-test:changed', () => { unsubscribe() }, -1)
  unsubscribe = events.subscribe('last', 'event-test:changed', () => { delivered = true })
  await events.emit('event-test:changed', {})
  unsubscribe()
  assert.equal(delivered, false)
})

test('manifest events validate names, duplicates and descriptions and survive npm normalization', () => {
  assert.deepEqual(validateManifest(manifest).events, manifest.events)
  assert.deepEqual(validatePackageManifest({ name: 'llmhub-plugin-event-test', version: '1.0.0', llmhub: { events: manifest.events } }).events, manifest.events)
  assert.throws(() => validateManifest({ ...manifest, id: 'llmhub' }))
  for (const events of [[{ name: 'other:changed', description: 'bad' }], [{ name: 'changed', description: '' }], [...manifest.events, ...manifest.events]]) {
    assert.throws(() => validateManifest({ ...manifest, events }))
  }
})

test('builtin event API is setup-only, declared, namespaced and revoked during cleanup', async () => {
  const events = new EventRegistry()
  const host = new BuiltinPluginHost({ eventRegistry: events, hookRegistry: new HookRegistry(), providerRegistry: new ProviderRegistry(), storage: {
    getItem: async () => null, setItem: async () => {}, removeItem: async () => {}
  } })
  let api: import('../server/plugins-runtime/manager.ts').PluginAPI
  let received = 0
  await host.register({ manifest, setup: (injected: typeof api) => {
    api = injected
    api.onEvent('event-test:changed', () => { received++ })
  } })
  assert.deepEqual(host.list()[0].publishedEvents, [{ name: 'event-test:changed', description: 'State changed' }])
  assert.deepEqual(host.list()[0].subscribedEvents, ['event-test:changed'])
  await api!.emitEvent('changed', {})
  assert.equal(received, 1)
  assert.throws(() => api!.onEvent('event-test:changed', () => {}), /registration is closed/)
  await assert.rejects(api!.emitEvent('missing', {}), /must be declared/)
  await assert.rejects(api!.emitEvent('llmhub:request-error', {}), /local event name/)
  await host.shutdown()
  await events.emit('event-test:changed', {})
  assert.equal(received, 1)
  await assert.rejects(api!.emitEvent('changed', {}), /inactive/)
})

test('failed builtin setup rolls back event subscriptions', async () => {
  const events = new EventRegistry()
  const host = new BuiltinPluginHost({ eventRegistry: events, hookRegistry: new HookRegistry(), providerRegistry: new ProviderRegistry(), storage: {
    getItem: async () => null, setItem: async () => {}, removeItem: async () => {}
  } })
  let received = 0
  await assert.rejects(host.register({ manifest, setup: (api: import('../server/plugins-runtime/manager.ts').PluginAPI) => {
    api.onEvent('event-test:changed', () => { received++ })
    throw new Error('setup failed')
  } }), /setup failed/)
  await events.emit('event-test:changed', {})
  assert.equal(received, 0)
})

test('runtime disable and re-enable revoke stale APIs and replace subscriptions', async () => {
  const { PluginManager } = require(`${buildDirectory}/plugins-runtime/manager.js`)
  const root = await mkdtemp(resolve('.programmer/event-lifecycle-'))
  const events = new EventRegistry()
  const values = new Map<string, unknown>()
  const manager = new PluginManager({ directory: root, eventRegistry: events, hookRegistry: new HookRegistry(), providerRegistry: new ProviderRegistry(), storage: {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: unknown) => { values.set(key, value) },
    removeItem: async (key: string) => { values.delete(key) }
  } })
  try {
    const directory = join(root, manifest.id)
    await mkdir(directory)
    await writeFile(join(directory, 'plugin.json'), JSON.stringify({ ...manifest, entry: 'index.mjs' }))
    await writeFile(join(directory, 'index.mjs'), `export default { setup(api) {
      let count = 0
      api.onEvent('event-test:changed', () => { count++ })
      api.registerRoute('GET', 'api', () => ({ emit: () => api.emitEvent('changed', {}), count: () => count, subscribe: () => api.onEvent('event-test:changed', () => {}) }))
    } }`)
    await manager.scan()
    await manager.enable(manifest.id)
    const stale = await manager.dispatchRoute(manifest.id, 'GET', 'api', {})
    assert.deepEqual(manager.list()[0].subscribedEvents, ['event-test:changed'])
    assert.deepEqual(manager.list()[0].publishedEvents, [{ name: 'event-test:changed', description: 'State changed' }])
    await stale.emit()
    assert.equal(stale.count(), 1)
    assert.throws(() => stale.subscribe(), /registration is closed/)
    await manager.disable(manifest.id)
    await assert.rejects(stale.emit(), /inactive/)
    await events.emit('event-test:changed', {})
    assert.equal(stale.count(), 1)
    assert.deepEqual(manager.list()[0].subscribedEvents, [])
    await manager.enable(manifest.id)
    const current = await manager.dispatchRoute(manifest.id, 'GET', 'api', {})
    await current.emit()
    assert.equal(current.count(), 1)
    assert.equal(stale.count(), 1)
  } finally {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
