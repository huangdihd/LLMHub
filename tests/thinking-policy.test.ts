import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

// thinking-policy imports the store without an extension, which Node's native
// TS loader cannot resolve — use the tsc-compiled build instead.
const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) {
  console.error('ADAPTER_BUILD not set — run via tests/run-all.sh')
  process.exit(1)
}
const { applyThinkingPolicy } = require(`${buildDir}/services/thinking-policy.js`)
const { DEFAULT_THINKING_SETTINGS } = require(`${buildDir}/stores/thinking.store.js`)

const base = (config: any = {}) => ({ messages: [], config })
const freshSettings = () => JSON.parse(JSON.stringify(DEFAULT_THINKING_SETTINGS))

test('policy leaves requests without client thinking untouched', async () => {
  const out = await applyThinkingPolicy(base(), 'p', freshSettings())
  assert.equal(out.config.thinking, undefined)
})

test('policy derives effort from a client budget via the configurable map', async () => {
  const out = await applyThinkingPolicy(
    base({ thinking: { enabled: true, budgetTokens: 12000 } }),
    'p',
    freshSettings()
  )
  assert.equal(out.config.thinking.effort, 'medium')
  assert.equal(out.config.thinking.budgetTokens, 12000)
})

test('policy derives budget from a client effort', async () => {
  const out = await applyThinkingPolicy(
    base({ thinking: { enabled: true, effort: 'low' } }),
    'p',
    freshSettings()
  )
  assert.equal(out.config.thinking.budgetTokens, 4096)
})

test('policy keeps an explicit client disable untouched', async () => {
  const out = await applyThinkingPolicy(
    base({ thinking: { enabled: false } }),
    'p',
    freshSettings()
  )
  assert.equal(out.config.thinking.enabled, false)
  assert.equal(out.config.thinking.effort, undefined)
})

test('policy forces server defaults only when respectClient is off', async () => {
  const settings = freshSettings()
  settings.respectClient = false
  settings.defaultEffort = 'xhigh'
  const out = await applyThinkingPolicy(
    base({ thinking: { enabled: true, effort: 'low' } }),
    'p',
    settings
  )
  assert.equal(out.config.thinking.effort, 'xhigh')
  assert.equal(out.config.thinking.budgetTokens, 32768)
})

test('policy applies provider budget overrides', async () => {
  const settings = freshSettings()
  const withoutOverride = await applyThinkingPolicy(
    base({ thinking: { enabled: true, budgetTokens: 10000 } }),
    'gem',
    settings
  )
  assert.equal(withoutOverride.config.thinking.effort, 'medium')
  settings.providerOverrides.gem = { budgetMap: { ...settings.budgetMap, high: 9000 } }
  const withOverride = await applyThinkingPolicy(
    base({ thinking: { enabled: true, budgetTokens: 10000 } }),
    'gem',
    settings
  )
  assert.equal(withOverride.config.thinking.effort, 'high')
})

test('policy normalizes legacy reasoning fields', async () => {
  const out = await applyThinkingPolicy(base({ reasoningEffort: 'high' }), 'p', freshSettings())
  assert.equal(out.config.thinking.effort, 'high')
  assert.equal(out.config.thinking.budgetTokens, 16384)
})

test('policy is disabled entirely when enabled=false', async () => {
  const settings = freshSettings()
  settings.enabled = false
  const out = await applyThinkingPolicy(
    base({ thinking: { enabled: true, budgetTokens: 12000 } }),
    'p',
    settings
  )
  assert.equal(out.config.thinking.effort, undefined)
})
