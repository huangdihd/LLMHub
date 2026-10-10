import assert from 'node:assert/strict'
import { beforeEach, afterEach, mock, test } from 'node:test'
import { createRequire } from 'node:module'
import type { ApiKeyRecord } from '../server/stores/auth.store.ts'

const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) {
  console.error('ADAPTER_BUILD not set — run via tests/run-all.sh')
  process.exit(1)
}
const baseline = process.env.CHARACTERIZATION_BASELINE === '1'
const { incrementCalls, getStats } = require(baseline ? `${buildDir}/utils/stats.js` : `${buildDir}/../builtin/stats/service.js`) as typeof import('../builtin/stats/service.ts')
const { trackUsage, addUsage } = require(baseline ? `${buildDir}/utils/stats.js` : `${buildDir}/../builtin/quota/service.js`) as typeof import('../builtin/quota/service.ts')
const { AuthStore: IdentityStore } = require(`${buildDir}/stores/auth.store.js`) as typeof import('../server/stores/auth.store.ts')
// Keep the characterization call sites while exercising the relocated real service.
class AuthStore extends IdentityStore {
  addUsage = baseline ? IdentityStore.prototype.addUsage : addUsage
}
const { getBillableTokens } = require(baseline ? `${buildDir}/services/model-token-billing.js` : `${buildDir}/../builtin/token-billing/service.js`) as typeof import('../builtin/token-billing/service.ts')

const keysKey = 'auth:api-keys'
const ratiosKey = 'settings:model-token-ratios'
const model = 'provider/model'
const month = '2026-06'
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'useStorage')
let values: Map<string, unknown>
let writes: Array<{ key: string; value: unknown }>
let reads: string[]

function keyRecord(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'key-1', name: 'Characterization', hash: 'not-a-real-hash',
    allowed_providers: ['provider'], allowed_models: [model],
    monthly_limit: 10000, tokens_used: 10, current_month: month, call_count: 7,
    created_at: '2026-01-01T00:00:00.000Z',
    model_quotas: { [model]: 1000 }, model_usage: { [model]: 4, other: 6 },
    provider_quotas: { provider: 2000 }, provider_usage: { provider: 4, other: 6 },
    fallback_strategy: { enabled: false, name: 'auto', priority: [] },
    ...overrides
  }
}

function eventFor(record?: Partial<ApiKeyRecord>): Parameters<typeof trackUsage>[0] {
  return { context: { _apiKeyRecord: record } } as unknown as Parameters<typeof trackUsage>[0]
}

function savedKey(): ApiKeyRecord {
  return (values.get(keysKey) as ApiKeyRecord[])[0]
}

beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: new Date(2026, 5, 15).getTime() })
  values = new Map([[keysKey, [keyRecord()]]])
  writes = []
  reads = []
  // Clone at the storage boundary: mutation alone must not masquerade as persistence.
  Object.defineProperty(globalThis, 'useStorage', {
    configurable: true,
    value: (namespace: string) => {
      assert.equal(namespace, 'data')
      return {
        async getItem(key: string) {
          reads.push(key)
          return structuredClone(values.get(key) ?? null)
        },
        async setItem(key: string, value: unknown) {
          writes.push({ key, value: structuredClone(value) })
          values.set(key, structuredClone(value))
        }
      }
    }
  })
})

afterEach(() => {
  mock.timers.reset()
  if (originalStorage) Object.defineProperty(globalThis, 'useStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'useStorage')
})

test('addUsage writes the full key array, accumulates all counters and preserves unrelated fields', async () => {
  const initial = keyRecord()
  const other = keyRecord({ id: 'key-2' })
  values.set(keysKey, [initial, other])
  const staleRecord = keyRecord({ tokens_used: 999, call_count: 999 })
  await new AuthStore().addUsage(staleRecord, 12.5, model, 'provider')
  const expected = {
    ...initial, tokens_used: 22.5, call_count: 8,
    model_usage: { [model]: 16.5, other: 6 },
    provider_usage: { provider: 16.5, other: 6 }
  }
  assert.deepEqual(writes, [{ key: keysKey, value: [expected, other] }])
  assert.deepEqual(savedKey(), expected)
  assert.equal(staleRecord.tokens_used, 999)
  assert.equal(values.has('stats:totalCalls'), false)
})

test('month rollover clears every monthly bucket but retains lifetime calls and quotas', async () => {
  const initial = keyRecord({ current_month: '2026-05' })
  values.set(keysKey, [initial])
  await new AuthStore().addUsage(initial, 3, model, 'provider')
  assert.deepEqual(savedKey(), {
    ...initial, current_month: month, tokens_used: 3, call_count: 8,
    model_usage: { [model]: 3 }, provider_usage: { provider: 3 }
  })
})

test('getBillableTokens uses exact model ratios, defaults and fractional billing', async () => {
  values.set(ratiosKey, { ratios: { [model]: { input: 0.5, cached: 0.1, output: 2 } } })
  const usage = { promptTokens: 11, cachedTokens: 4, completionTokens: 3, totalTokens: 999 }
  assert.equal(await getBillableTokens(usage, model), 9.9)
  assert.equal(await getBillableTokens(usage, 'model'), 14)
  assert.equal(await getBillableTokens(usage), 14)
  assert.equal(await getBillableTokens({ promptTokens: 10, cachedTokens: 50, completionTokens: -2 }, model), 1)
})

test('trackUsage writes billed rather than raw tokens to all three usage counters', async () => {
  values.set(ratiosKey, { ratios: { [model]: { input: 0.5, cached: 0.1, output: 2 } } })
  await trackUsage(eventFor(keyRecord()), { promptTokens: 100, cachedTokens: 40, completionTokens: 3 }, model)
  assert.equal(savedKey().tokens_used, 50)
  assert.equal(savedKey().model_usage[model], 44)
  assert.equal(savedKey().provider_usage.provider, 44)
  assert.equal(savedKey().call_count, 8)
  assert.deepEqual(writes.map(write => write.key), [keysKey])
})

test('legacy numeric usage remains pre-billed and bypasses model ratios', async () => {
  values.set(ratiosKey, { ratios: { [model]: { input: 100, cached: 100, output: 100 } } })
  await trackUsage(eventFor(keyRecord()), 12, model)
  assert.equal(savedKey().tokens_used, 22)
  assert.equal(savedKey().model_usage[model], 16)
  assert.equal(savedKey().provider_usage.provider, 16)
  assert.equal(savedKey().call_count, 8)
  assert.equal(reads.includes(ratiosKey), false)
})

test('zero usage still increments calls and creates model/provider buckets', async () => {
  await trackUsage(eventFor(keyRecord()), 0, 'new/model')
  assert.equal(savedKey().tokens_used, 10)
  assert.equal(savedKey().call_count, 8)
  assert.equal(savedKey().model_usage['new/model'], 0)
  assert.equal(savedKey().provider_usage.new, 0)
})

test('unqualified and absent models do not produce provider buckets', async () => {
  await trackUsage(eventFor(keyRecord()), 2, 'unqualified')
  await trackUsage(eventFor(keyRecord()), 3)
  assert.equal(savedKey().tokens_used, 15)
  assert.equal(savedKey().call_count, 9)
  assert.deepEqual(savedKey().model_usage, { [model]: 4, other: 6, unqualified: 2 })
  assert.deepEqual(savedKey().provider_usage, { provider: 4, other: 6 })
})

test('missing record is an early no-op; admin without id and revoked ids read but never write', async () => {
  await trackUsage(eventFor(), 10, model)
  assert.deepEqual(reads, [])
  await trackUsage(eventFor({ name: 'Gateway Session', tokens_used: 0 }), 10, model)
  await trackUsage(eventFor(keyRecord({ id: 'revoked' })), 10, model)
  assert.deepEqual(reads, [keysKey, keysKey])
  assert.deepEqual(writes, [])
  assert.deepEqual(savedKey(), keyRecord())
})

test('global calls are independent of key usage and include completions without a usage report', async () => {
  assert.deepEqual(await getStats(), { totalCalls: 0 })
  await incrementCalls()
  assert.deepEqual(savedKey(), keyRecord())
  await trackUsage(eventFor(keyRecord()), 1, model)
  await trackUsage(eventFor(keyRecord()), 1, model)
  assert.deepEqual(await getStats(), { totalCalls: 1 })
  assert.equal(savedKey().call_count, 9)
  await incrementCalls()
  await trackUsage(eventFor({ name: 'Gateway Session' }), 1, model)
  assert.deepEqual(await getStats(), { totalCalls: 2 })
  assert.equal(savedKey().call_count, 9)
})

test('provider attribution uses the first slash segment and keeps the complete model identifier', async () => {
  await trackUsage(eventFor(keyRecord()), 2, 'provider/group/model')
  assert.equal(savedKey().model_usage['provider/group/model'], 2)
  assert.equal(savedKey().provider_usage.provider, 6)
  assert.equal(savedKey().provider_usage['provider/group'], undefined)
})

test('numeric negative usage currently reduces counters instead of clamping', async () => {
  await trackUsage(eventFor(keyRecord()), -2, model)
  assert.equal(savedKey().tokens_used, 8)
  assert.equal(savedKey().model_usage[model], 2)
  assert.equal(savedKey().provider_usage.provider, 2)
  assert.equal(savedKey().call_count, 8)
})

test('legacy keys without usage buckets initialize both buckets on write', async () => {
  const initial = keyRecord()
  Reflect.deleteProperty(initial, 'model_usage')
  Reflect.deleteProperty(initial, 'provider_usage')
  values.set(keysKey, [initial])
  await trackUsage(eventFor(initial), 2, model)
  assert.deepEqual(savedKey().model_usage, { [model]: 2 })
  assert.deepEqual(savedKey().provider_usage, { provider: 2 })
  assert.equal(savedKey().tokens_used, 12)
})

test('write failures are swallowed only by trackUsage and do not persist cloned mutations', async context => {
  const failure = new Error('write unavailable')
  Object.defineProperty(globalThis, 'useStorage', {
    configurable: true,
    value: () => ({
      getItem: async (key: string) => structuredClone(values.get(key) ?? null),
      setItem: async () => { throw failure }
    })
  })
  const logged = context.mock.method(console, 'error', () => {})
  await assert.doesNotReject(trackUsage(eventFor(keyRecord()), 2, model))
  assert.deepEqual(logged.mock.calls[0].arguments, ['[LLMHub] Failed to track usage:', failure])
  assert.deepEqual(savedKey(), keyRecord())
  await assert.rejects(new AuthStore().addUsage(keyRecord(), 2, model, 'provider'), error => error === failure)
  await assert.rejects(incrementCalls(), error => error === failure)
})

test('trackUsage logs and swallows storage failure while incrementCalls rejects', async context => {
  const failure = new Error('storage unavailable')
  Object.defineProperty(globalThis, 'useStorage', {
    configurable: true,
    value: () => ({ getItem: async () => { throw failure } })
  })
  const logged = context.mock.method(console, 'error', () => {})
  await assert.doesNotReject(trackUsage(eventFor(keyRecord()), 1, model))
  assert.deepEqual(logged.mock.calls[0].arguments, ['[LLMHub] Failed to track usage:', failure])
  await assert.rejects(incrementCalls(), error => error === failure)
  assert.deepEqual(writes, [])
})


test('unified embedding usage uses billing ratios rather than legacy numeric bypass', async () => {
  values.set(ratiosKey, { ratios: { [model]: { input: 2, cached: 1, output: 3 } } })
  await trackUsage(eventFor(keyRecord()), { promptTokens: 12, completionTokens: 0 }, model)
  assert.equal(savedKey().tokens_used, 34)
  assert.equal(savedKey().call_count, 8)
})

test('concurrent usage transactions preserve updates across different keys', async () => {
  const first = keyRecord()
  const second = keyRecord({ id: 'key-2' })
  values.set(keysKey, [first, second])
  await Promise.all(Array.from({ length: 30 }, async (_, index) => {
    await Promise.all([
      addUsage(index % 2 ? first : second, 2, model, 'provider'),
      incrementCalls()
    ])
  }))
  for (const record of values.get(keysKey) as ApiKeyRecord[]) {
    assert.equal(record.call_count, 22)
    assert.equal(record.tokens_used, 40)
    assert.equal(record.model_usage[model], 34)
  }
  assert.deepEqual(await getStats(), { totalCalls: 30 })
})
