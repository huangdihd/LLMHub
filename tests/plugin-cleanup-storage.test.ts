import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { PluginStorage } from '../server/plugins-runtime/manager.ts'

const require = createRequire(import.meta.url)
const buildDirectory = process.env.ADAPTER_BUILD
if (!buildDirectory) throw new Error('Run through tests/run-all.sh')
const { ProviderRegistry } = require(`${buildDirectory}/core/registry.js`)
const { HookRegistry } = require(`${buildDirectory}/core/hooks.js`)
const { EventRegistry } = require(`${buildDirectory}/core/events.js`)
const { PluginManager } = require(`${buildDirectory}/plugins-runtime/manager.js`)

interface Controls {
  storage: PluginStorage
  cleanupStarted: Promise<void>
  cleanupFinished: Promise<void>
  callbackStarted: Promise<void>
  callbackFinished: Promise<void>
  releaseCleanup(): void
  releaseCallback(): void
  failures: unknown[]
}

async function fixture(probeExpiredCleanup = false) {
  const cleanupTimeoutMs = probeExpiredCleanup ? 30 : 2000
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'llmhub-plugin-cleanup-storage-'))
  const values = new Map<string, unknown>()
  const storage = {
    async getItem(key: string) { return structuredClone(values.get(key) ?? null) },
    async setItem(key: string, value: unknown) { values.set(key, structuredClone(value)) },
    async removeItem(key: string) { values.delete(key) }
  }
  const hookRegistry = new HookRegistry()
  const eventRegistry = new EventRegistry()
  const manager = new PluginManager({ directory: root, storage, hookRegistry, eventRegistry, providerRegistry: new ProviderRegistry(), cleanupTimeoutMs })
  const directory = path.join(root, 'cleanup-storage')
  await mkdir(directory)
  await writeFile(path.join(directory, 'plugin.json'), JSON.stringify({ id: 'cleanup-storage', name: 'Cleanup storage', version: '1.0.0', engines: { llmhub: '*' }, entry: 'index.mjs' }))
  await writeFile(path.join(directory, 'index.mjs'), `
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
export default { async setup(context) {
  const cleanupStarted = gate();
  const cleanupFinished = gate();
  const callbackStarted = gate();
  const callbackFinished = gate();
  const cleanupGate = gate();
  const callbackGate = gate();
  const failures = [];
  const attemptStorage = async () => {
    for (const operation of [
      () => context.storage.getItem('pending'),
      () => context.storage.setItem('pending', 'late-write'),
      () => context.storage.removeItem('preserved')
    ]) {
      try { await operation(); failures.push(null); }
      catch (error) { failures.push(error); }
    }
  };
  const callback = async () => {
    callbackStarted.release();
    await callbackGate.promise;
    await attemptStorage();
    callbackFinished.release();
  };
  context.onEvent('llmhub:models-refreshed', callback);
  context.registerHook({ id: 'pending', onModels: callback });
  context.registerRoute('GET', 'controls', () => ({
    storage: context.storage, failures,
    cleanupStarted: cleanupStarted.promise, cleanupFinished: cleanupFinished.promise,
    callbackStarted: callbackStarted.promise, callbackFinished: callbackFinished.promise,
    releaseCleanup: cleanupGate.release, releaseCallback: callbackGate.release
  }));
  await context.storage.setItem('pending', 'buffered');
  await context.storage.setItem('preserved', 'keep');
  return async () => {
    cleanupStarted.release();
    await cleanupGate.promise;
    if (${probeExpiredCleanup}) {
      await attemptStorage();
    } else {
      const pending = await context.storage.getItem('pending');
      await context.storage.setItem('flushed', pending);
      await context.storage.removeItem('pending');
    }
    cleanupFinished.release();
  };
} };
`)
  await manager.scan()
  await manager.enable('cleanup-storage')
  const controls = await manager.dispatchRoute('cleanup-storage', 'GET', 'controls', {}) as Controls
  return {
    manager, hookRegistry, eventRegistry, controls,
    value: (key: string) => values.get(`runtime-plugins:cleanup-storage:storage:${key}`),
    async close() {
      controls.releaseCleanup()
      controls.releaseCallback()
      await manager.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  }
}

function assertInactive(failures: unknown[]) {
  assert.equal(failures.length, 3)
  for (const failure of failures) {
    assert.ok(failure instanceof Error)
    assert.match(failure.message, /Plugin is inactive/)
  }
}

test('stop cleanup can read, flush and remove buffered storage after awaiting', { timeout: 5000 }, async () => {
  const current = await fixture()
  try {
    const stopped = current.manager.disable('cleanup-storage')
    await current.controls.cleanupStarted
    current.controls.releaseCleanup()
    await stopped
    await current.controls.cleanupFinished
    assert.equal(current.value('flushed'), 'buffered')
    assert.equal(current.value('pending'), undefined)
    assert.equal(current.value('preserved'), 'keep')
  } finally { await current.close() }
})

test('timed-out cleanup continuation loses storage access', { timeout: 5000 }, async () => {
  const current = await fixture(true)
  try {
    const stopped = current.manager.disable('cleanup-storage')
    await current.controls.cleanupStarted
    await stopped
    assert.equal(current.manager.list().find((plugin: { id: string }) => plugin.id === 'cleanup-storage').error, 'Plugin cleanup failed')
    current.controls.releaseCleanup()
    await current.controls.cleanupFinished
    assertInactive(current.controls.failures)
    assert.equal(current.value('pending'), 'buffered')
    assert.equal(current.value('preserved'), 'keep')
  } finally { await current.close() }
})

for (const source of ['hook', 'event'] as const) {
  test(`in-flight ${source} cannot borrow storage access from concurrent cleanup`, { timeout: 5000 }, async () => {
    const current = await fixture()
    try {
      const callback = source === 'hook'
        ? current.hookRegistry.models([], {})
        : current.eventRegistry.emit('llmhub:models-refreshed', { validModelIds: [] })
      await current.controls.callbackStarted
      const stopped = current.manager.disable('cleanup-storage')
      await current.controls.cleanupStarted
      // Resume the old callback while cleanup is still suspended, not after stop.
      current.controls.releaseCallback()
      await callback
      await current.controls.callbackFinished
      assertInactive(current.controls.failures)
      assert.equal(current.value('pending'), 'buffered')
      assert.equal(current.value('preserved'), 'keep')
      current.controls.releaseCleanup()
      await stopped
      assert.equal(current.value('flushed'), 'buffered')
    } finally { await current.close() }
  })
}

test('retained API cannot access storage after disable returns', { timeout: 5000 }, async () => {
  const current = await fixture()
  try {
    current.controls.releaseCleanup()
    await current.manager.disable('cleanup-storage')
    const storage = current.controls.storage
    for (const operation of [
      () => storage.getItem('preserved'),
      () => storage.setItem('preserved', 'late-write'),
      () => storage.removeItem('preserved')
    ]) {
      await assert.rejects(async () => operation(), /Plugin is inactive/)
    }
    assert.equal(current.value('preserved'), 'keep')
    assert.equal(current.value('flushed'), 'buffered')
  } finally { await current.close() }
})
