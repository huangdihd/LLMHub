import assert from 'node:assert/strict'
import test from 'node:test'
import { harness } from './subscription-usage-harness.mjs'
const plain = value => JSON.parse(JSON.stringify(value))
const sample = { provider: 'account', protocol: 'runtime', plan: 'pro', windows: [], fetched_at: '' }

test('usage expands lazily, caches per provider, refreshes explicitly, and removes state', async () => {
  const requests = []
  let release
  const environment = harness((url, options) => { requests.push([url, options]); return new Promise(resolve => { release = resolve }) })
  const state = environment.state()
  const opening = state.toggleUsageDetails('a/b')
  assert.equal(state.usageState('a/b').loading, true)
  assert.equal(state.usageState('account').expanded, false)
  await state.toggleUsageDetails('a/b')
  await state.toggleUsageDetails('a/b')
  assert.equal(requests.length, 1)
  release({ ...sample, windows: null })
  await opening
  assert.deepEqual(plain(state.usageState('a/b').data.windows), [])
  await state.toggleUsageDetails('a/b')
  await state.toggleUsageDetails('a/b')
  assert.equal(requests.length, 1)
  const refresh = state.fetchSubscriptionUsage('a/b', true)
  assert.equal(requests[1][0], '/api/hub/providers/a%2Fb/subscription-usage?refresh=1')
  release(sample)
  await refresh
  state.remove('a/b')
  assert.equal(state.usageState('a/b').data, null)
  assert.equal(state.usageState('a/b').expanded, false)
})

test('fetch errors preserve previous data, clear busy state, and permit retry', async () => {
  let failure = { data: { message: 'Quota unavailable' } }
  const environment = harness(async () => { if (failure) throw failure; return sample })
  const state = environment.state()
  state.usageState('account').data = sample
  await state.fetchSubscriptionUsage('account')
  assert.equal(state.usageState('account').error, 'Quota unavailable')
  assert.equal(state.usageState('account').loading, false)
  assert.equal(state.usageState('account').data.plan, 'pro')
  failure = null
  await state.fetchSubscriptionUsage('account')
  assert.equal(state.usageState('account').error, '')
  environment.mounted.forEach(callback => callback())
  assert.equal(environment.intervals.size, 1)
  environment.unmounted.forEach(callback => callback())
  assert.equal(environment.intervals.size, 0)
})

test('reset requires confirmation, sends selected credit, refreshes, and clears busy state on failure', async () => {
  const requests = []
  let failure = false
  const environment = harness(async (url, options) => {
    requests.push([url, options])
    if (failure) throw new Error('reset unavailable')
    return options ? { code: 'reset', windows_reset: 1 } : sample
  })
  const state = environment.state()
  environment.setAccepted(false)
  await state.useSubscriptionReset('a/b')
  assert.equal(requests.length, 0)
  environment.setAccepted(true)
  await state.useSubscriptionReset('a/b', { id: 'selected' })
  assert.equal(requests[0][0], '/api/hub/providers/a%2Fb/subscription-reset')
  assert.deepEqual(plain(requests[0][1]), { method: 'POST', body: { credit_id: 'selected' } })
  assert.equal(requests[1][0], '/api/hub/providers/a%2Fb/subscription-usage?refresh=1')
  assert.equal(environment.notifications[0].description, 'Reset applied to 1 usage limit window.')
  failure = true
  await state.useSubscriptionReset('a/b')
  assert.equal(environment.errors[0][1], 'Unable to use usage limit reset')
  assert.equal(state.usageState('a/b').resettingCreditId, '')
})

test('generic SSR preserves loading/error/data precedence, credits, accessibility, and reset capability gate', async () => {
  const environment = harness()
  const state = environment.state()
  const record = state.usageState('account')
  assert.equal(await environment.render('claude-subscription', state), '')
  record.expanded = true
  record.loading = true
  assert.match(await environment.render('claude-subscription', state), /Loading quota details/)
  record.loading = false
  record.error = 'Unavailable'
  assert.match(await environment.render('claude-subscription', state), /role="alert">Unavailable/)
  record.error = ''
  record.data = { ...sample, windows: [{ id: 'weekly', label: 'Weekly', used_percent: 150, reset_at: 'invalid' }], credits: { unlimited: true }, reset_credits: { available_count: 1 } }
  let markup = await environment.render('claude-subscription', state)
  assert.match(markup, /aria-valuenow="100"/)
  assert.match(markup, /Unlimited/)
  assert.match(markup, /at an unknown time/)
  assert.doesNotMatch(markup, /Use reset/)
  markup = await environment.render('claude-subscription', state, true)
  assert.match(markup, /Use reset/)
  assert.equal(state.formatPercent(NaN), '0%')
  assert.equal(state.formatCredits({}), 'Balance unavailable')
})

test('provider type endpoint publishes capability booleans rather than implementation functions', () => {
  const environment = harness()
  const definitions = [
    { id: 'plain', secretConnectionFields: [] },
    { id: 'usage', subscriptionUsage() {}, secretConnectionFields: [] },
    { id: 'reset', subscriptionUsage() {}, resetSubscriptionUsage() {}, secretConnectionFields: [] }
  ]
  const source = environment.source('server/api/hub/provider-types.get.ts').replace("import { providerRegistry } from '../../core/registry'", `const providerRegistry = { list: () => globalThis.definitions }; const defineEventHandler = (handler: () => unknown) => handler`)
  const response = plain(environment.execute(source, 'provider-types.ts', { definitions }).default())
  assert.deepEqual(response.map(item => [item.supportsSubscriptionUsage, item.supportsSubscriptionReset]), [[false, false], [true, false], [true, true]])
  assert.ok(response.every(item => !('subscriptionUsage' in item) && !('resetSubscriptionUsage' in item)))
})
