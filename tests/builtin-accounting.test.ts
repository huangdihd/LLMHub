import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import type { AccountingCompletion } from '../server/core/hooks.ts'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('Run via tests/run-all.sh')
const { HookRegistry } = require(`${build}/core/hooks.js`) as typeof import('../server/core/hooks.ts')

function fixture() {
  const hooks = new HookRegistry()
  // Register in reverse billing order: priorities, not setup order, own the contract.
  for (const name of ['quota', 'stats', 'token-billing']) {
    require(`${build}/../builtin/${name}/plugin.js`).default.setup({
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

test('builtin accounting separates attempts, bills usage before quota, and attributes provider buckets', async () => {
  await withStorage(async ({ hooks, context, values, writes }) => {
    await hooks.accountingComplete({ kind: 'attempt' }, context)
    assert.equal(values.get('stats:totalCalls'), 1)
    assert.deepEqual(writes, ['stats:totalCalls'])
    const completion: AccountingCompletion = {
      kind: 'usage', model: 'provider/model',
      usage: { promptTokens: 100, cachedTokens: 40, completionTokens: 3 }
    }
    await hooks.accountingComplete(completion, context)
    assert.equal(completion.tokens, 40)
    const saved = (values.get('auth:api-keys') as any[])[0]
    assert.equal(saved.tokens_used, 50)
    assert.equal(saved.call_count, 8)
    assert.deepEqual(saved.model_usage, { 'provider/model': 40 })
    assert.deepEqual(saved.provider_usage, { provider: 40 })
    assert.deepEqual(writes, ['stats:totalCalls', 'auth:api-keys'])
  })
})

test('builtin numeric accounting bypasses billing settings and counts zero usage', async () => {
  await withStorage(async ({ hooks, context, reads, values }) => {
    await hooks.accountingComplete({ kind: 'usage', usage: 0, model: 'provider/model' }, context)
    assert.equal(reads.includes('settings:model-token-ratios'), false)
    const saved = (values.get('auth:api-keys') as any[])[0]
    assert.equal(saved.tokens_used, 10)
    assert.equal(saved.call_count, 8)
    assert.deepEqual(saved.model_usage, { 'provider/model': 0 })
    assert.equal(values.has('stats:totalCalls'), false)
  })
})

test('builtin accounting without identity performs no usage storage access', async () => {
  await withStorage(async ({ hooks, reads, writes }) => {
    await hooks.accountingComplete({ kind: 'usage', usage: 7 }, { incomingProtocol: 'openai-chat' })
    assert.deepEqual(reads, [])
    assert.deepEqual(writes, [])
  })
})

test('builtin quota persistence failure rejects at the accounting boundary', async () => {
  await withStorage(async ({ hooks, context, storage }) => {
    const failure = new Error('quota write failed')
    storage.setItem = async () => { throw failure }
    await assert.rejects(hooks.accountingComplete({ kind: 'usage', usage: 2 }, context), error => error === failure)
  })
})
