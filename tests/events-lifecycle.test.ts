import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { PluginAPI } from '../server/plugins-runtime/manager.ts'

const require = createRequire(import.meta.url)
const buildDirectory = process.env.ADAPTER_BUILD
if (!buildDirectory) throw new Error('Run through tests/run-all.sh')
const { PluginManager } = require(`${buildDirectory}/plugins-runtime/manager.js`)
const { EventRegistry } = require(`${buildDirectory}/core/events.js`)
const { HookRegistry } = require(`${buildDirectory}/core/hooks.js`)
const { ProviderRegistry } = require(`${buildDirectory}/core/registry.js`)

const publisherId = 'lifecycle-publisher'
const subscriberId = 'lifecycle-subscriber'
const eventName = `${publisherId}:changed`

interface EventProbe {
  emit(name?: string): Promise<void>
  count(): number
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(complete => { resolve = complete })
  return { promise, resolve }
}

async function fixture(context: TestContext, timeoutMs = 5000) {
  // macOS temp paths can traverse /var's symlink; plugin validation requires physical paths.
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'llmhub-events-lifecycle-'))
  const events = new EventRegistry()
  const storage = new Map<string, unknown>()
  const manager = new PluginManager({
    directory,
    timeoutMs,
    eventRegistry: events,
    hookRegistry: new HookRegistry(),
    providerRegistry: new ProviderRegistry(),
    storage: {
      getItem: async (key: string) => storage.get(key) ?? null,
      setItem: async (key: string, value: unknown) => { storage.set(key, value) },
      removeItem: async (key: string) => { storage.delete(key) },
      getKeys: async (prefix: string) => [...storage.keys()].filter(key => key.startsWith(prefix))
    }
  })
  context.after(async () => {
    try { await manager.shutdown() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })

  async function install(id: string, setup: string) {
    const pluginDirectory = join(directory, id)
    await mkdir(pluginDirectory)
    await writeFile(join(pluginDirectory, 'plugin.json'), JSON.stringify({
      id, name: id, version: '1.0.0', entry: 'index.mjs',
      events: [{ name: 'changed', description: 'State changed' }]
    }))
    // Import-free fixtures also work inside isolated reload generations.
    await writeFile(join(pluginDirectory, 'index.mjs'), `export default { async setup(api) { ${setup} } }`)
    await manager.scan()
  }

  async function installProbe(id: string, subscribedEvent = eventName) {
    await install(id, `
      let count = 0
      api.onEvent(${JSON.stringify(subscribedEvent)}, () => { count++ })
      const probe = {
        emit: (name = 'changed') => api.emitEvent(name, {}),
        count: () => count
      }
      api.registerRoute('GET', 'probe', () => probe)
    `)
    await manager.enable(id)
    return probe(id)
  }

  async function probe(id: string): Promise<EventProbe> {
    return manager.dispatchRoute(id, 'GET', 'probe', {})
  }

  return { manager, events, storage, install, installProbe, probe }
}

test('runtime subscriber loads without its publisher and receives when that publisher appears', async context => {
  const { manager, installProbe } = await fixture(context)
  const subscriber = await installProbe(subscriberId)
  assert.equal(manager.list().some((plugin: { id: string }) => plugin.id === publisherId), false)
  const record = manager.list().find((plugin: { id: string }) => plugin.id === subscriberId)
  assert.equal(record.enabled, true)
  assert.deepEqual(record.subscribedEvents, [eventName])
  assert.equal(subscriber.count(), 0)

  const publisher = await installProbe(publisherId)
  await publisher.emit()
  assert.equal(subscriber.count(), 1)
})

test('publisher reload preserves independent subscriber instances and revokes the old publisher', async context => {
  const { manager, installProbe, probe } = await fixture(context)
  const subscriber = await installProbe(subscriberId)
  const publisher = await installProbe(publisherId)
  await publisher.emit()
  await manager.reload(publisherId)

  const currentSubscriber = await probe(subscriberId)
  assert.equal(currentSubscriber.count, subscriber.count)
  assert.deepEqual(manager.list().find((plugin: { id: string }) => plugin.id === subscriberId).subscribedEvents, [eventName])
  await assert.rejects(publisher.emit(), /inactive/)
  const currentPublisher = await probe(publisherId)
  await currentPublisher.emit()
  assert.equal(subscriber.count(), 2)
  assert.equal(publisher.count(), 1)
  assert.equal(currentPublisher.count(), 1)
})

test('subscriber reload removes the previous listener rather than delivering to both generations', async context => {
  const { manager, installProbe, probe } = await fixture(context)
  const publisher = await installProbe(publisherId)
  const subscriber = await installProbe(subscriberId)
  await publisher.emit()
  await manager.reload(subscriberId)
  const currentSubscriber = await probe(subscriberId)
  assert.notEqual(currentSubscriber.count, subscriber.count)
  assert.equal(currentSubscriber.count(), 0)
  await publisher.emit()
  await publisher.emit()
  assert.equal(subscriber.count(), 1)
  assert.equal(currentSubscriber.count(), 2)
  await assert.rejects(subscriber.emit(), /inactive/)
})

test('uninstall removes subscriptions and revokes retained emit functions', async context => {
  const { manager, events, installProbe } = await fixture(context)
  const publisher = await installProbe(publisherId)
  const subscriber = await installProbe(subscriberId)
  let leakedEmissions = 0
  const unsubscribe = events.subscribe('test-observer', `${subscriberId}:changed`, () => { leakedEmissions++ })
  context.after(unsubscribe)
  await publisher.emit()
  await manager.uninstall(subscriberId)
  assert.equal(manager.list().some((plugin: { id: string }) => plugin.id === subscriberId), false)
  await publisher.emit()
  await assert.rejects(subscriber.emit(), /inactive/)
  assert.equal(subscriber.count(), 1)
  assert.equal(leakedEmissions, 0)

  await manager.uninstall(publisherId)
  await events.emit(eventName, {})
  await assert.rejects(publisher.emit(), /inactive/)
  assert.equal(publisher.count(), 2)
})

test('runtime emission rejects another plugin namespace, the system namespace and undeclared local events', async context => {
  const { events, installProbe } = await fixture(context)
  const publisher = await installProbe(publisherId)
  const received: string[] = []
  for (const name of [`${subscriberId}:changed`, 'llmhub:request-error', `${publisherId}:undeclared`]) {
    context.after(events.subscribe('test-observer', name, () => { received.push(name) }))
  }
  await assert.rejects(publisher.emit(`${subscriberId}:changed`), /local event name/)
  await assert.rejects(publisher.emit('llmhub:request-error'), /local event name/)
  await assert.rejects(publisher.emit('undeclared'), /must be declared/)
  assert.deepEqual(received, [])
  await publisher.emit()
  assert.equal(publisher.count(), 1)
})

test('throwing runtime setup rolls back subscriptions and invalidates its captured API', async context => {
  const { manager, events, storage, install } = await fixture(context)
  let capturedAPI: PluginAPI | undefined
  let received = 0
  storage.set(`runtime-plugins:${subscriberId}:storage:control`, {
    capture: (api: PluginAPI) => { capturedAPI = api },
    receive: () => { received++ }
  })
  await install(subscriberId, `
    const control = await api.storage.getItem('control')
    control.capture(api)
    api.onEvent(${JSON.stringify(eventName)}, control.receive)
    throw new Error('intentional setup failure')
  `)
  await assert.rejects(manager.enable(subscriberId), /activation failed/)
  assert.ok(capturedAPI)
  await events.emit(eventName, {})
  assert.equal(received, 0)
  assert.throws(() => capturedAPI.onEvent(eventName, () => {}), /registration is closed/)
  await assert.rejects(capturedAPI.emitEvent('changed', {}), /inactive/)
  const record = manager.list().find((plugin: { id: string }) => plugin.id === subscriberId)
  assert.equal(record.enabled, false)
  assert.deepEqual(record.subscribedEvents, [])
})

test('timed-out runtime setup cannot register or emit when its suspended continuation resumes', { timeout: 10000 }, async context => {
  const { manager, events, storage, install } = await fixture(context, 1000)
  const started = deferred()
  const resume = deferred()
  const finished = deferred()
  let capturedAPI: PluginAPI | undefined
  let registrationError: unknown
  let emissionError: unknown
  let received = 0
  let emitted = 0
  context.after(events.subscribe('test-observer', `${subscriberId}:changed`, () => { emitted++ }))
  storage.set(`runtime-plugins:${subscriberId}:storage:control`, {
    capture: (api: PluginAPI) => { capturedAPI = api; started.resolve() },
    receive: () => { received++ },
    wait: () => resume.promise,
    registrationFailed: (error: unknown) => { registrationError = error },
    emissionFailed: (error: unknown) => { emissionError = error },
    finish: finished.resolve
  })
  await install(subscriberId, `
    const control = await api.storage.getItem('control')
    api.onEvent(${JSON.stringify(eventName)}, control.receive)
    control.capture(api)
    await control.wait()
    try {
      try { api.onEvent(${JSON.stringify(eventName)}, control.receive) }
      catch (error) { control.registrationFailed(error) }
      try { await api.emitEvent('changed', {}) }
      catch (error) { control.emissionFailed(error) }
    } finally { control.finish() }
  `)
  // Attach the rejection handler before waiting for setup to enter its controlled pause.
  const activation = assert.rejects(manager.enable(subscriberId), /timed out/)
  try {
    await Promise.race([started.promise, activation.then(() => { throw new Error('Setup did not start before timeout') })])
    await activation
    await events.emit(eventName, {})
    assert.equal(received, 0)
  } finally {
    resume.resolve()
  }
  await finished.promise
  assert.ok(capturedAPI)
  assert.match(String(registrationError), /registration is closed/)
  assert.match(String(emissionError), /inactive/)
  await events.emit(eventName, {})
  await assert.rejects(capturedAPI.emitEvent('changed', {}), /inactive/)
  assert.equal(received, 0)
  assert.equal(emitted, 0)
  const record = manager.list().find((plugin: { id: string }) => plugin.id === subscriberId)
  assert.equal(record.enabled, false)
  assert.deepEqual(record.subscribedEvents, [])
})
