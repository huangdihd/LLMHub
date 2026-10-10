import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const buildDirectory = process.env.ADAPTER_BUILD
assert.ok(buildDirectory, 'ADAPTER_BUILD must point to the precompiled server directory')
const storeModule = require(`${buildDirectory}/stores/provider.store.js`)
const fetchModule = require(`${buildDirectory}/utils/fetch.js`)
const { ProviderLoader } = require(`${buildDirectory}/providers/loader.js`)
const now = 1_800_000_000_000
const refreshWindow = 300_000
const protocols = ['codex', 'claude', 'antigravity'] as const

function configuration(protocol: string) {
  return {
    name: 'fixture', protocol, enabled: true, use_custom_models: false,
    models: [{ id: 'configured', display_name: 'Local', capabilities: { tools: false } }],
    connection: {
      base_url: 'https://upstream.invalid', api_key: 'old-access', refresh_token: 'old-refresh',
      token_expires_at: now + refreshWindow + 1, project_id: 'existing-project',
      account_id: 'old-account', account_email: 'old@example.invalid', id_token: 'old-id',
      subscription_type: 'old-plan', rate_limit_tier: 'old-tier', device_id: 'device',
      version: '2023-06-01', client_version: 'fixture-version', proxy: 'preserved'
    } as Record<string, any>
  }
}
function jwt(payload: object) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}
function model(name: string, displayName: string | undefined, capabilities: unknown) {
  return { id: `fixture/${name}`, provider: 'fixture', name, display_name: displayName, capabilities }
}

// Replace only external OAuth/storage/transport boundaries; execute compiled production code.
for (const protocol of protocols) {
  const title = protocol[0].toUpperCase() + protocol.slice(1)
  const providerDirectory = `${buildDirectory}/../builtin/provider-${protocol === 'claude' ? 'claude-subscription' : protocol}`
  const authentication = require(`${providerDirectory}/${protocol}-auth.js`)
  const ensure = require(`${providerDirectory}/${protocol}-token-manager.js`)[`ensure${title}AccessToken`]
  const refreshName = `refresh${title}Tokens`

  await test(`${protocol}: refresh boundary, unknown expiry and missing access token`, async context => {
    context.mock.method(Date, 'now', () => now)
    let refreshes = 0
    context.mock.method(authentication, refreshName, async () => {
      refreshes++
      return { access_token: 'new-access', expires_in: 600 }
    })
    context.mock.method(storeModule, 'getProviderStore', () => ({
      update: async (_name: string, patch: any) => ({ ...configuration(`${protocol}-subscription`), ...patch })
    }))
    const unrelated = configuration('openai')
    assert.equal(await ensure(unrelated), unrelated)
    const valid = configuration(`${protocol}-subscription`)
    assert.equal(await ensure(valid), valid)
    assert.equal(refreshes, 0)
    for (const expiry of [now + refreshWindow, now - 1]) {
      const expired = configuration(`${protocol}-subscription`)
      expired.connection.token_expires_at = expiry
      await ensure(expired)
    }
    assert.equal(refreshes, 2)
    const unknown = configuration(`${protocol}-subscription`)
    delete unknown.connection.token_expires_at
    await ensure(unknown)
    assert.equal(refreshes, protocol === 'antigravity' ? 3 : 2)
    const missing = configuration(`${protocol}-subscription`)
    missing.connection.api_key = ''
    await ensure(missing)
    assert.equal(refreshes, protocol === 'antigravity' ? 4 : 3)
    if (protocol === 'codex') {
      const encoded = configuration('codex-subscription')
      delete encoded.connection.token_expires_at
      encoded.connection.api_key = jwt({ exp: (now + refreshWindow) / 1000 })
      await ensure(encoded)
      assert.equal(refreshes, 4)
    }
  })

  await test(`${protocol}: single-flight writes exact fields and mutates caller connection`, async context => {
    context.mock.method(Date, 'now', () => now)
    const pending = deferred<any>()
    let refreshes = 0
    context.mock.method(authentication, refreshName, (token: string) => {
      assert.equal(token, 'old-refresh')
      refreshes++
      return pending.promise
    })
    const original = configuration(`${protocol}-subscription`)
    original.connection.token_expires_at = now
    const before = { ...original.connection }
    const writes: any[] = []
    let persisted: any
    context.mock.method(storeModule, 'getProviderStore', () => ({ update: async (name: string, patch: any) => {
      assert.equal(name, original.name)
      writes.push(patch)
      persisted = { ...original, ...patch }
      return persisted
    } }))
    const first = ensure(original)
    const second = ensure(structuredClone(original))
    const accessToken = protocol === 'codex' ? jwt({ exp: now / 1000 + 900, account_id: 'access-account' }) : 'new-access'
    const idToken = jwt({ account_id: 'id-account' })
    pending.resolve({ access_token: accessToken, refresh_token: 'rotated-refresh', id_token: idToken,
      expires_in: 900, subscription_type: 'new-plan', rate_limit_tier: 'new-tier' })
    const results = await Promise.all([first, second])
    const expected = { ...before, api_key: accessToken, refresh_token: 'rotated-refresh', token_expires_at: now + 900_000 }
    if (protocol === 'codex') Object.assign(expected, { id_token: idToken, account_id: 'id-account' })
    if (protocol === 'claude') Object.assign(expected, { subscription_type: 'new-plan', rate_limit_tier: 'new-tier' })
    assert.equal(refreshes, 1)
    assert.deepEqual(writes, [{ connection: expected }])
    assert.deepEqual(original.connection, expected)
    assert.equal(results[0], persisted)
    assert.equal(results[1], persisted)
  })

  await test(`${protocol}: optional fields preserved; failures release single-flight`, async context => {
    context.mock.method(Date, 'now', () => now)
    const config = configuration(`${protocol}-subscription`)
    config.connection.token_expires_at = now
    const cause = new Error('OAuth unavailable')
    let fail = true
    let writes = 0
    context.mock.method(authentication, refreshName, async () => {
      if (fail) throw cause
      return { access_token: 'opaque-access', expires_in: protocol === 'claude' ? 0 : 600 }
    })
    context.mock.method(storeModule, 'getProviderStore', () => ({ update: async (_name: string, patch: any) => {
      writes++
      return { ...config, ...patch }
    } }))
    await assert.rejects(ensure(config), (error: any) => {
      assert.equal(error.cause, cause)
      assert.equal(error._statusCode, 401)
      assert.equal(error._providerError, true)
      assert.equal(error._errorBody.code, `${protocol}_reconnect_required`)
      return true
    })
    assert.equal(writes, 0)
    const missingRefresh = structuredClone(config)
    delete missingRefresh.connection.refresh_token
    await assert.rejects(ensure(missingRefresh), (error: any) => error._errorBody.code === `${protocol}_reconnect_required`)
    fail = false
    const before = { ...config.connection }
    await ensure(config)
    const expiryByProtocol = { codex: undefined, claude: now + 3_600_000, antigravity: now + 600_000 }
    assert.deepEqual(config.connection, { ...before, api_key: 'opaque-access',
      token_expires_at: expiryByProtocol[protocol] })
    assert.equal(writes, 1)
    config.connection.token_expires_at = now
    context.mock.method(storeModule, 'getProviderStore', () => ({ update: async () => undefined }))
    await assert.rejects(ensure(config), /Provider not found: fixture/)
  })
}

await test('antigravity: missing project discovers account without refreshing valid token', async context => {
  context.mock.method(Date, 'now', () => now)
  const authentication = require(`${buildDirectory}/../builtin/provider-antigravity/antigravity-auth.js`)
  const { ensureAntigravityAccessToken } = require(`${buildDirectory}/../builtin/provider-antigravity/antigravity-token-manager.js`)
  context.mock.method(authentication, 'refreshAntigravityTokens', () => { throw new Error('unexpected refresh') })
  context.mock.method(authentication, 'discoverAntigravityAccount', async (accessToken: string) => {
    assert.equal(accessToken, 'old-access')
    return { projectId: 'discovered-project', email: 'new@example.invalid', tier: 'new-tier' }
  })
  const config = configuration('antigravity-subscription')
  delete config.connection.project_id
  delete config.connection.refresh_token
  const before = { ...config.connection }
  const writes: unknown[] = []
  context.mock.method(storeModule, 'getProviderStore', () => ({ update: async (_name: string, patch: any) => {
    writes.push(patch)
    return { ...config, ...patch }
  } }))
  await ensureAntigravityAccessToken(config)
  assert.deepEqual(writes, [{ connection: { ...before, refresh_token: undefined, project_id: 'discovered-project',
    account_email: 'new@example.invalid', subscription_type: 'new-tier' } }])
})

const defaults = { tools: true, streaming: true }
const visionDefaults = { vision: true, tools: true, streaming: true }
const discoveryCases = [
  { protocol: 'openai', path: '/models', body: { data: [
    { id: 'configured', display_name: 'Upstream', capabilities: { tools: true } },
    { id: 'first', supported_capabilities: { vision: true } }, { id: 'second', abilities: { tools: true } }, { id: 'plain' }
  ] }, expected: [model('configured', 'Local', { tools: false }), model('first', 'first', { vision: true }),
    model('second', 'second', { tools: true }), model('plain', 'plain', {})] },
  { protocol: 'claude', path: '/v1/models', body: { data: [
    { id: 'configured' }, { id: 'plain', display_name: 'Claude', capabilities: { tools: true } }
  ] }, expected: [model('configured', 'Local', { tools: false }), model('plain', 'Claude', undefined)] },
  { protocol: 'gemini', path: '/v1beta/models', body: { models: [
    { name: 'models/configured', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/plain', displayName: 'Gemini', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }
  ] }, expected: [model('configured', 'Local', { tools: false }), model('plain', 'Gemini', undefined)] },
  { protocol: 'codex-subscription', path: '/models?client_version=fixture-version', body: { models: [
    { slug: 'configured' }, { id: 'plain', displayName: 'Codex' }, { model: 'alternate' }, {}
  ] }, expected: [model('configured', 'Local', { tools: false }), model('plain', 'Codex', defaults), model('alternate', 'alternate', defaults)] },
  { protocol: 'claude-subscription', path: '/v1/models', body: { data: [
    { id: 'configured' }, { id: 'plain', display_name: 'Claude subscription' }, {}
  ] }, expected: [model('configured', 'Local', { tools: false }), model('plain', 'Claude subscription', visionDefaults)] },
  { protocol: 'antigravity-subscription', path: '/v1internal:fetchAvailableModels', body: {
    models: { configured: { displayName: 'Remote configured' }, plain: { displayName: 'Antigravity' } }
  }, expected: [model('configured', 'Remote configured', visionDefaults), model('plain', 'Antigravity', visionDefaults)] }
]

for (const entry of discoveryCases) {
  await test(`${entry.protocol}: discovery shape, request policy, custom bypass and failure fallback`, async context => {
    context.mock.method(Date, 'now', () => now)
    const config = configuration(entry.protocol)
    context.mock.method(storeModule, 'getProviderStore', () => ({ getAll: async () => [config] }))
    const calls: any[] = []
    let fail = false
    context.mock.method(fetchModule, 'fetchWithRetry', async (url: string, options: any, connection: any) => {
      calls.push({ url, options, connection })
      if (fail) throw new Error('fixture transport failure')
      return Response.json(entry.body)
    })
    context.mock.method(console, 'error', () => {})
    context.mock.method(console, 'info', () => {})
    const loader = new ProviderLoader()
    await loader.loadAll()
    assert.deepEqual(await loader.fetchModels('fixture'), entry.expected)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `${config.connection.base_url}${entry.path}`)
    assert.equal(calls[0].connection, config.connection)
    assert.equal(calls[0].options.timeout, 10_000)
    assert.equal(calls[0].options.enable_timeout, true)
    assert.equal(calls[0].options.maxRetries, 1)
    const headers = new Headers(calls[0].options.headers)
    if (entry.protocol === 'claude') assert.equal(headers.get('x-api-key'), 'old-access')
    else if (entry.protocol === 'gemini') assert.equal(headers.get('x-goog-api-key'), 'old-access')
    else assert.equal(headers.get('authorization'), 'Bearer old-access')
    if (entry.protocol === 'codex-subscription') {
      assert.equal(headers.get('ChatGPT-Account-Id'), 'old-account')
      assert.equal(headers.get('x-codex-installation-id'), 'device')
    }
    if (entry.protocol === 'antigravity-subscription') {
      assert.deepEqual(JSON.parse(calls[0].options.body), { project: 'existing-project' })
    }
    await loader.fetchModels('fixture')
    assert.equal(calls.length, 2, 'direct fetchModels is not cached')
    config.use_custom_models = true
    const local = [model('configured', 'Local', { tools: false })]
    assert.deepEqual(await loader.fetchModels('fixture'), local)
    assert.equal(calls.length, 2, 'custom models bypass transport')
    config.use_custom_models = false
    fail = true
    assert.deepEqual(await loader.fetchModels('fixture'), local)
    await assert.rejects(loader.fetchModels('missing'), /Provider not found: missing/)
  })
}

await test('cache: shared cold single-flight, exact TTL stale refresh and invalidation fences old results', async context => {
  let clock = now
  context.mock.method(Date, 'now', () => clock)
  context.mock.method(console, 'info', () => {})
  const config = configuration('openai')
  context.mock.method(storeModule, 'getProviderStore', () => ({ getAll: async () => [config] }))
  let pending = deferred<Response>()
  let calls = 0
  context.mock.method(fetchModule, 'fetchWithRetry', () => { calls++; return pending.promise })
  const first = new ProviderLoader()
  const second = new ProviderLoader()
  await first.loadAll()
  await second.loadAll()
  ProviderLoader.invalidateCache()
  try {
    const cold = first.fetchAllModels()
    const concurrent = second.fetchAllModels()
    assert.equal(calls, 1)
    pending.resolve(Response.json({ data: [{ id: 'old' }] }))
    const old = await cold
    assert.equal(await concurrent, old)
    clock += refreshWindow - 1
    assert.equal(await second.fetchAllModels(), old)
    assert.equal(calls, 1)
    clock++
    pending = deferred<Response>()
    assert.equal(await first.fetchAllModels(), old)
    assert.equal(await second.fetchAllModels(), old)
    assert.equal(calls, 2)
    const obsoleteRefresh = ProviderLoader.modelRefreshPromise
    const obsoleteResponse = pending
    ProviderLoader.invalidateCache()
    pending = deferred<Response>()
    const fresh = second.fetchAllModels()
    assert.equal(calls, 3)
    pending.resolve(Response.json({ data: [{ id: 'fresh' }] }))
    assert.deepEqual(await fresh, [model('fresh', 'fresh', {})])
    obsoleteResponse.resolve(Response.json({ data: [{ id: 'obsolete' }] }))
    await obsoleteRefresh
    assert.deepEqual(await first.fetchAllModels(), [model('fresh', 'fresh', {})])
    assert.equal(calls, 3)
  } finally {
    ProviderLoader.invalidateCache()
  }
})
