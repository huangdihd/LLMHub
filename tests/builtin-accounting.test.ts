import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import type { CompletionInfo } from '../server/core/hooks.ts'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('Run via tests/run-all.sh')
const { HookRegistry } = require(`${build}/core/hooks.js`) as typeof import('../server/core/hooks.ts')

function fixture() {
  const hooks = new HookRegistry()
  const services = new Map<string, object>()
  // Billing provides a service, not a completion hook or priority-dependent mutation.
  for (const name of ['token-billing', 'quota', 'stats']) {
    require(`${build}/../builtin/${name}/plugin.js`).default.setup({
      provide: (service: object) => services.set(name, service),
      require: (id: string) => services.get(id),
      registerHook: (hook: any) => hooks.register({ ...hook, id: `${name}:${hook.id}` })
    })
  }
  const now = new Date()
  const record = {
    id: 'test-key', tokens_used: 10, call_count: 7,
    current_month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
    model_usage: {}, provider_usage: {}
  }
  const values = new Map<string, unknown>([
    ['auth:api-keys', [record]],
    ['settings:model-token-ratios', { ratios: { 'provider/model': { input: 0.5, cached: 0.1, output: 2 } } }]
  ])
  const reads: string[] = []
  const writes: string[] = []
  const storage = {
    async getItem(key: string) { reads.push(key); return structuredClone(values.get(key) ?? null) },
    async setItem(key: string, value: unknown) { writes.push(key); values.set(key, structuredClone(value)) }
  }
  const context = { incomingProtocol: 'openai-chat', apiKeyRecord: record as any }
  return { hooks, values, reads, writes, storage, context }
}

async function withStorage(run: (state: ReturnType<typeof fixture>) => Promise<void>) {
  const state = fixture()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'useStorage')
  Object.defineProperty(globalThis, 'useStorage', { configurable: true, value: () => state.storage })
  try { await run(state) } finally {
    if (original) Object.defineProperty(globalThis, 'useStorage', original)
    else Reflect.deleteProperty(globalThis, 'useStorage')
  }
}

test('completion bills unified usage without mutating its payload and counts once', async () => {
  await withStorage(async ({ hooks, context, values }) => {
    const completion: CompletionInfo = Object.freeze({
      model: 'provider/model',
      usage: { promptTokens: 100, cachedTokens: 40, completionTokens: 3 }
    })
    await hooks.complete(completion, context)
    assert.equal(values.get('stats:totalCalls'), 1)
    assert.equal('tokens' in completion, false)
    const saved = (values.get('auth:api-keys') as any[])[0]
    assert.equal(saved.tokens_used, 50)
    assert.equal(saved.call_count, 8)
    assert.deepEqual(saved.model_usage, { 'provider/model': 40 })
    assert.deepEqual(saved.provider_usage, { provider: 40 })
  })
})

test('embedding unified usage applies input ratios', async () => {
  await withStorage(async ({ hooks, context, reads, values }) => {
    await hooks.complete({ model: 'provider/model', usage: { promptTokens: 12, completionTokens: 0 } }, context)
    assert.equal(reads.includes('settings:model-token-ratios'), true)
    const saved = (values.get('auth:api-keys') as any[])[0]
    assert.equal(saved.tokens_used, 16)
    assert.equal(saved.call_count, 8)
    assert.deepEqual(saved.model_usage, { 'provider/model': 6 })
  })
})

test('missing usage, including failed calls, increments calls without token buckets', async () => {
  await withStorage(async ({ hooks, context, reads, values }) => {
    await hooks.complete({ model: 'provider/model' }, context)
    await hooks.complete({ error: new Error('upstream failed') }, context)
    assert.equal(reads.includes('settings:model-token-ratios'), false)
    const saved = (values.get('auth:api-keys') as any[])[0]
    assert.equal(saved.tokens_used, 10)
    assert.equal(saved.call_count, 9)
    assert.deepEqual(saved.model_usage, {})
    assert.deepEqual(saved.provider_usage, {})
    assert.equal(values.get('stats:totalCalls'), 2)
  })
})

test('zero usage still counts once and produces zero-valued token buckets', async () => {
  await withStorage(async ({ hooks, context, values }) => {
    await hooks.complete({ model: 'provider/model', usage: { promptTokens: 0, completionTokens: 0 } }, context)
    const saved = (values.get('auth:api-keys') as any[])[0]
    assert.equal(saved.tokens_used, 10)
    assert.equal(saved.call_count, 8)
    assert.deepEqual(saved.model_usage, { 'provider/model': 0 })
    assert.equal(values.get('stats:totalCalls'), 1)
  })
})

test('completion without identity counts globally but does not access key usage', async () => {
  await withStorage(async ({ hooks, reads, writes }) => {
    await hooks.complete({}, { incomingProtocol: 'openai-chat' })
    assert.deepEqual(reads, ['stats:totalCalls'])
    assert.deepEqual(writes, ['stats:totalCalls'])
  })
})

test('concurrent completions do not lose global or per-key counts', async () => {
  await withStorage(async ({ hooks, context, values }) => {
    await Promise.all(Array.from({ length: 40 }, () => hooks.complete({
      model: 'provider/model', usage: { promptTokens: 2, completionTokens: 0 }
    }, context)))
    const saved = (values.get('auth:api-keys') as any[])[0]
    assert.equal(saved.call_count, 47)
    assert.equal(saved.tokens_used, 50)
    assert.deepEqual(saved.model_usage, { 'provider/model': 40 })
    assert.deepEqual(saved.provider_usage, { provider: 40 })
    assert.equal(values.get('stats:totalCalls'), 40)
  })
})

test('quota refuses setup without its billing service', () => {
  const quota = require(`${build}/../builtin/quota/plugin.js`).default
  for (const service of [undefined, {}]) {
    assert.throws(() => quota.setup({
      require: () => service,
      registerHook: () => assert.fail('must fail before registering hooks')
    }), /requires the token-billing service/)
  }
})

test('completion storage failures are logged and subsequent completions recover', async testContext => {
  await withStorage(async ({ hooks, context, storage, values }) => {
    const failure = new Error('quota write failed')
    const setItem = storage.setItem
    storage.setItem = async () => { throw failure }
    const logged = testContext.mock.method(console, 'error', () => {})
    await assert.doesNotReject(hooks.complete({}, context))
    assert.equal(logged.mock.calls.length, 2)
    for (const call of logged.mock.calls) assert.equal(call.arguments[1], failure)
    storage.setItem = setItem
    await hooks.complete({}, context)
    assert.equal((values.get('auth:api-keys') as any[])[0].call_count, 8)
    assert.equal(values.get('stats:totalCalls'), 1)
  })
})
