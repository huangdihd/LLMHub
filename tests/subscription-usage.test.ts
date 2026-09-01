import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) {
  console.error('ADAPTER_BUILD not set — run via tests/run-all.sh')
  process.exit(1)
}

const {
  getSubscriptionUsage,
  normalizeClaudeUsage,
  normalizeCodexUsage
} = require(`${buildDir}/services/subscription-usage.js`)

let passed = 0
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(() => {
    passed++
    console.log(`  ok - ${name}`)
  }).catch((error: any) => {
    console.error(`  FAIL - ${name}`)
    console.error(error.stack || error.message)
    process.exitCode = 1
  })
}

console.log('subscription usage normalization')

await test('Codex usage includes plan, quota windows, resets and credits', () => {
  const usage = normalizeCodexUsage('codex', {
    plan_type: 'plus',
    rate_limit: {
      primary_window: {
        percent_left: 72,
        limit_window_seconds: 18000,
        reset_at: 1893456000
      },
      secondary_window: {
        used_percent: 41,
        limit_window_seconds: 604800,
        reset_time_ms: 1893542400000
      }
    },
    credits: {
      has_credits: true,
      balance: '12.50',
      approx_local_messages: 25
    }
  })

  assert.equal(usage.plan, 'plus')
  assert.deepEqual(usage.windows.map((window: any) => ({
    id: window.id,
    label: window.label,
    used: window.used_percent,
    reset: window.reset_at
  })), [
    { id: 'primary', label: '5-hour', used: 28, reset: '2030-01-01T00:00:00.000Z' },
    { id: 'secondary', label: '7-day', used: 41, reset: '2030-01-02T00:00:00.000Z' }
  ])
  assert.deepEqual(usage.credits, { balance: '12.50', detail: 'About 25 local messages' })
})

await test('Claude usage includes standard, scoped and extra-usage windows', () => {
  const usage = normalizeClaudeUsage('claude-sub', {
    five_hour: { utilization: 25, resets_at: '2030-01-01T05:00:00Z' },
    seven_day: { utilization: 60, resets_at: '2030-01-07T00:00:00Z' },
    limits: [{
      kind: 'weekly_scoped',
      percent: 75,
      resets_at: '2030-01-07T00:00:00Z',
      scope: { model: { display_name: 'Opus' } }
    }],
    extra_usage: {
      is_enabled: true,
      monthly_limit: 2000,
      used_credits: 500,
      currency: 'USD',
      utilization: 25
    }
  }, 'max')

  assert.equal(usage.plan, 'max')
  assert.deepEqual(usage.windows.map((window: any) => [window.label, window.used_percent]), [
    ['5-hour', 25],
    ['7-day', 60],
    ['7-day Opus', 75],
    ['Extra usage', 25]
  ])
  assert.equal(usage.windows[3].detail, 'USD 5.00 of 20.00')
})

console.log('subscription usage requests')

await test('Codex usage request uses wham endpoint and account header', async () => {
  let captured: any
  const config = {
    name: 'codex-usage-request',
    protocol: 'codex-subscription',
    connection: {
      base_url: 'https://chatgpt.com/backend-api/codex',
      api_key: 'access',
      refresh_token: 'refresh',
      account_id: 'acct_1',
      token_expires_at: Date.now() + 3600000
    },
    models: []
  }
  const usage = await getSubscriptionUsage(config, true, async (url: string, init: RequestInit) => {
    captured = { url, headers: init.headers as Record<string, string> }
    return Response.json({ plan_type: 'pro', rate_limit: {} })
  })
  assert.equal(captured.url, 'https://chatgpt.com/backend-api/wham/usage')
  assert.equal(captured.headers.Authorization, 'Bearer access')
  assert.equal(captured.headers['ChatGPT-Account-Id'], 'acct_1')
  assert.equal(usage.plan, 'pro')
})

await test('Claude usage request uses official OAuth endpoint and persisted plan metadata', async () => {
  let captured: any
  const config = {
    name: 'claude-usage-request',
    protocol: 'claude-subscription',
    connection: {
      base_url: 'https://api.anthropic.com',
      api_key: 'access',
      refresh_token: 'refresh',
      token_expires_at: Date.now() + 3600000,
      subscription_type: 'max'
    },
    models: []
  }
  const usage = await getSubscriptionUsage(config, true, async (url: string, init: RequestInit) => {
    captured = { url, headers: init.headers as Record<string, string> }
    return Response.json({ five_hour: { utilization: 10 } })
  })
  assert.equal(captured.url, 'https://api.anthropic.com/api/oauth/usage')
  assert.equal(captured.headers.Authorization, 'Bearer access')
  assert.equal(captured.headers['anthropic-beta'], 'oauth-2025-04-20')
  assert.equal(usage.plan, 'max')
  assert.equal(usage.windows[0].used_percent, 10)
})

console.log(`\n${passed} subscription usage test groups passed${process.exitCode ? ', with FAILURES' : ''}`)
