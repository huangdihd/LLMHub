import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import type { H3Event } from 'h3'
import type { CompletionInfo } from '../server/core/hooks.ts'
import type { LLMResponse, Usage } from '../server/core/types.ts'
import type { ProviderManager } from '../server/providers/manager.ts'
import type { ApiKeyRecord } from '../server/stores/auth.store.ts'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('Run via tests/run-all.sh')
const { BuiltinPluginHost } = require(`${build}/../builtin/host.js`) as typeof import('../builtin/host.ts')
const { builtinCatalog } = require(`${build}/../builtin/catalog.js`) as typeof import('../builtin/catalog.ts')
const { HookRegistry } = require(`${build}/core/hooks.js`) as typeof import('../server/core/hooks.ts')
const { EventRegistry } = require(`${build}/core/events.js`) as typeof import('../server/core/events.ts')
const { ProviderRegistry } = require(`${build}/core/registry.js`) as typeof import('../server/core/registry.ts')
const { RequestPipeline, drainCompletions } = require(`${build}/core/pipeline.js`) as typeof import('../server/core/pipeline.ts')

const cases: { name: string; response: string | LLMResponse; usage: Usage; tokens: number }[] = [
  { name: 'string response defaults to zero usage', response: 'local answer', usage: { promptTokens: 0, completionTokens: 0 }, tokens: 0 },
  { name: 'explicit zero usage', response: { content: 'local answer', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } }, usage: { promptTokens: 0, completionTokens: 0 }, tokens: 0 },
  { name: 'supplied usage applies input, cached and output ratios', response: { content: 'local answer', finishReason: 'stop', usage: { promptTokens: 100, cachedTokens: 40, completionTokens: 3 } }, usage: { promptTokens: 100, cachedTokens: 40, completionTokens: 3 }, tokens: 40 }
]

for (const scenario of cases) {
  test(`plugin response accounting: ${scenario.name}`, async () => {
    const hooks = new HookRegistry()
    const events = new EventRegistry()
    const now = new Date()
    const record: ApiKeyRecord = {
      id: 'plugin-key', name: 'Plugin accounting', hash: 'unused',
      allowed_providers: [], allowed_models: [], monthly_limit: 0,
      tokens_used: 10, call_count: 7, created_at: now.toISOString(),
      current_month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      model_quotas: {}, provider_quotas: {}, model_usage: {}, provider_usage: {},
      fallback_strategy: { enabled: false, name: 'auto', priority: [] }
    }
    const values = new Map<string, unknown>([
      ['auth:api-keys', [record]],
      ['stats:totalCalls', 5],
      ['settings:model-token-ratios', { ratios: { 'provider/model': { input: 0.5, cached: 0.1, output: 2 } } }]
    ])
    const writes: string[] = []
    const storage = {
      async getItem<T>(key: string): Promise<T | null> { return structuredClone(values.get(key) ?? null) as T | null },
      async setItem(key: string, value: unknown) { writes.push(key); values.set(key, structuredClone(value)) },
      async removeItem(key: string) { values.delete(key) }
    }
    const host = new BuiltinPluginHost({ hookRegistry: hooks, eventRegistry: events, providerRegistry: new ProviderRegistry(), storage })
    const original = Object.getOwnPropertyDescriptor(globalThis, 'useStorage')
    Object.defineProperty(globalThis, 'useStorage', { configurable: true, value: () => storage })
    try {
      for (const id of ['access-control', 'token-billing', 'stats', 'quota']) {
        const plugin = builtinCatalog.find(plugin => plugin.manifest.id === id)
        assert.ok(plugin)
        await host.register(plugin)
      }
      await host.register({
        manifest: { id: 'local-response', version: '1.0.0' }, layer: './local-response',
        setup(api) {
          api.registerHook({ id: 'answer', onRequest: () => ({ response: scenario.response }) })
        }
      })
      const completions: CompletionInfo[] = []
      events.subscribe('observe-accounting', 'llmhub:request-complete', ({ completion }) => { completions.push(completion) })
      const manager = {
        getRequestContext: () => ({ providerName: 'provider' }),
        resolveAdapter: () => assert.fail('plugin response must not resolve an upstream'),
        callLLM: () => assert.fail('plugin response must not call an upstream'),
        buildGatewayError: (message: string) => new Error(message)
      } as unknown as ProviderManager
      const pipeline = new RequestPipeline(manager, { context: { _apiKeyRecord: record } } as unknown as H3Event, 'openai-chat', hooks, events)
      const prepared = await pipeline.prepare({ model: 'provider/model', messages: [], config: {} })
      assert.equal(pipeline.hasResponse, true)
      assert.equal(prepared.resolved, undefined)
      assert.equal((await pipeline.call(prepared.request)).content, 'local answer')
      // HTTP completion/cleanup can both finish the same pipeline; accounting must be idempotent.
      await Promise.all([pipeline.complete(), pipeline.complete()])
      await drainCompletions()
      await pipeline.complete()
      await drainCompletions()

      assert.equal(completions.length, 1)
      assert.deepEqual(completions[0].responseSource, { pluginId: 'local-response', hookId: 'local-response:answer' })
      assert.equal(completions[0].model, 'provider/model')
      assert.deepEqual(completions[0].usage, scenario.usage)
      assert.equal(completions[0].error, undefined)
      assert.equal(values.get('stats:totalCalls'), 6)
      const saved = (values.get('auth:api-keys') as ApiKeyRecord[])[0]
      assert.equal(saved.call_count, 8)
      assert.equal(saved.tokens_used, 10 + scenario.tokens)
      assert.deepEqual(saved.model_usage, { 'provider/model': scenario.tokens })
      assert.deepEqual(saved.provider_usage, { provider: scenario.tokens })
      assert.equal(writes.filter(key => key === 'stats:totalCalls').length, 1)
      assert.equal(writes.filter(key => key === 'auth:api-keys').length, 1)
    } finally {
      await drainCompletions()
      await host.shutdown()
      if (original) Object.defineProperty(globalThis, 'useStorage', original)
      else Reflect.deleteProperty(globalThis, 'useStorage')
    }
  })
}
