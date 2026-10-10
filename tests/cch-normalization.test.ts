import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('Run via tests/run-all.sh')
const { HookRegistry } = require(`${build}/core/hooks.js`) as typeof import('../server/core/hooks.ts')

const prompt = 'x-anthropic-billing-header: cc_version=2.1; cch=a1b2c; rest'

async function run(provider: Record<string, unknown> | null, context: Record<string, unknown>, systemPrompt = prompt) {
  const hooks = new HookRegistry()
  require(`${build}/../builtin/cch-normalization/plugin.js`).default.setup({
    registerHook: (hook: any) => hooks.register({ ...hook, id: `cch-normalization:${hook.id}` })
  })
  const storage = {
    async getItem() { return provider },
    async getKeys() { return provider ? ['providers:upstream'] : [] }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'useStorage')
  Object.defineProperty(globalThis, 'useStorage', { configurable: true, value: () => storage })
  try {
    const request = { model: 'upstream/model', messages: [], config: { systemPrompt } }
    const result = await hooks.request(request as any, context as any)
    return { request, result }
  } finally {
    if (original) Object.defineProperty(globalThis, 'useStorage', original)
    else Reflect.deleteProperty(globalThis, 'useStorage')
  }
}

test('CCH is normalized for Claude messages when the provider opts in', async () => {
  const { request, result } = await run({ name: 'upstream', normalize_cch: true }, { incomingProtocol: 'claude-messages', providerName: 'upstream' })
  assert.equal(result.config.systemPrompt, 'x-anthropic-billing-header: cc_version=2.1; cch=00000; rest')
  assert.equal(request.config.systemPrompt, prompt, 'the incoming request is not mutated')
})

test('CCH is left alone for other protocols, providers that did not opt in, and unresolved providers', async () => {
  const optedIn = { name: 'upstream', normalize_cch: true }
  for (const [provider, context] of [
    [optedIn, { incomingProtocol: 'openai-chat', providerName: 'upstream' }],
    [{ name: 'upstream' }, { incomingProtocol: 'claude-messages', providerName: 'upstream' }],
    [optedIn, { incomingProtocol: 'claude-messages' }],
    [null, { incomingProtocol: 'claude-messages', providerName: 'upstream' }]
  ] as const) {
    const { request, result } = await run(provider, context)
    assert.equal(result, request)
  }
  // An empty system prompt has nothing to normalize.
  const { request, result } = await run(optedIn, { incomingProtocol: 'claude-messages', providerName: 'upstream' }, '')
  assert.equal(result, request)
})
