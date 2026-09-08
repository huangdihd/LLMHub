import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) {
  console.error('ADAPTER_BUILD not set — run via tests/run-all.sh')
  process.exit(1)
}
const { calculateBillableTokens } = require(`${buildDir}/services/model-token-billing.js`)
const { validateModelTokenRatioSettings } = require(`${buildDir}/stores/model-token-ratios.store.js`)

const usage = { promptTokens: 1000, completionTokens: 200, cachedTokens: 600 }

test('settings preserve model-specific ratios above and below 100%', () => {
  assert.deepEqual(validateModelTokenRatioSettings({
    ratios: { 'provider/model': { input: 0.5, output: 5, cached: 0.1 } }
  }), {
    ratios: { 'provider/model': { input: 0.5, output: 5, cached: 0.1 } }
  })
})

test('defaults bill all input, output, and cached tokens at full value', () => {
  assert.equal(calculateBillableTokens(usage, { input: 1, output: 1, cached: 1 }), 1200)
})

test('applies separate ratios to uncached input, output, and cached tokens', () => {
  assert.equal(calculateBillableTokens(usage, { input: 0.5, output: 0.25, cached: 0.1 }), 310)
})

test('does not subtract an invalid cached count beyond total input', () => {
  assert.equal(
    calculateBillableTokens(
      { promptTokens: 100, completionTokens: 20, cachedTokens: 150 },
      { input: 0.5, output: 1, cached: 0.1 }
    ),
    30
  )
})

test('treats missing cached usage as ordinary input', () => {
  assert.equal(
    calculateBillableTokens(
      { promptTokens: 100, completionTokens: 20 },
      { input: 0.5, output: 2, cached: 0 }
    ),
    90
  )
})
