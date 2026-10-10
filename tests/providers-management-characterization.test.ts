import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const nativeRequire = createRequire(import.meta.url)
const compiled = new Map<string, string>()
const protocols = ['openai', 'claude', 'gemini', 'codex-subscription', 'claude-subscription', 'antigravity-subscription']
const confidential = ['api_key', 'refresh_token', 'id_token', 'device_id', 'account_id', 'project_id', 'account_email']
type Event = { body?: any; name?: string; id?: string; actor?: string; query?: Record<string, unknown> }
type NetworkReply = { match: string; body: unknown; status?: number }

// Execute real routes, stores, login services and HTTP clients. Only Nitro transport,
// storage, cache invalidation and fetch are replaced. Transpilation stays in memory;
// no build output, user storage, OAuth environment or real network is touched.
function harness() {
  const modules = new Map<string, any>()
  const records = new Map<string, any>()
  const replies: NetworkReply[] = []
  const requests: Array<{ url: string; options: any }> = []
  let setup = true
  let invalidations = 0
  const createError = (options: { statusCode: number; message: string }) => Object.assign(new Error(options.message), options)
  const storage = {
    async getItem(key: string) { return records.has(key) ? structuredClone(records.get(key)) : null },
    async setItem(key: string, value: unknown) { records.set(key, structuredClone(value)) },
    async getKeys(prefix: string) { return [...records.keys()].filter(key => key.startsWith(prefix)) },
    async removeItem(key: string) { records.delete(key) },
    async hasItem(key: string) { return records.has(key) }
  }
  function load(path: string): any {
    const absolute = resolve(root, path)
    if (modules.has(absolute)) return modules.get(absolute).exports
    if (absolute === resolve(root, 'server/providers/loader.ts')) return { ProviderLoader: { invalidateCache() { invalidations++ } } }
    if (absolute === resolve(root, 'server/stores/auth.store.ts')) return { getAuthStore: () => ({
      isSetup: async () => setup,
      getSSRFConfig: async () => ({ enabled: true, allowed_hosts: [] })
    }) }
    if (!compiled.has(absolute)) compiled.set(absolute, ts.transpileModule(readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText)
    const module = { exports: {} }
    modules.set(absolute, module)
    runInNewContext(compiled.get(absolute)!, {
      module, exports: module.exports, URL, URLSearchParams, Buffer, TextEncoder, TextDecoder,
      Response, Headers, Request, AbortController, AbortSignal, crypto: globalThis.crypto,
      setTimeout, clearTimeout, console,
      process: { env: { ANTIGRAVITY_OAUTH_CLIENT_ID: 'test-client', ANTIGRAVITY_OAUTH_CLIENT_SECRET: 'test-secret' } },
      createError, useStorage: () => storage,
      defineEventHandler: (handler: unknown) => handler,
      readBody: async (event: Event) => event.body,
      getRouterParam: (event: Event, name: 'name' | 'id') => event[name],
      getQuery: (event: Event) => event.query ?? {},
      throwFormattedError: (error: Error) => { throw error },
      fetch: async (url: string, options: any) => {
        requests.push({ url: String(url), options })
        const reply = replies.shift()
        assert.ok(reply, `Unexpected network request: ${url}`)
        assert.ok(String(url).includes(reply.match), `Expected ${reply.match}, received ${url}`)
        return Response.json(reply.body, { status: reply.status ?? 200 })
      },
      require: (name: string) => {
        if (name === 'h3') return { getCookie: (event: Event) => event.actor ?? 'test-admin' }
        if (name.startsWith('node:')) return nativeRequire(name)
        assert.ok(name.startsWith('.'), `Unexpected dependency: ${name}`)
        return load(resolve(dirname(absolute), `${name.replace(/\.ts$/, '')}.ts`))
      }
    }, { filename: absolute })
    return module.exports
  }
  // Load composition-owned compatibility defaults into this isolated VM registry.
  load('builtin/assembly.ts')
  const registry = load('server/core/registry.ts').providerRegistry
  for (const provider of ['openai', 'claude', 'gemini', 'codex', 'claude-subscription', 'antigravity']) {
    load(`builtin/provider-${provider}/plugin.ts`).default.setup({
      registerProvider: (definition: any) => registry.register(definition)
    })
  }
  const store = load('server/stores/provider.store.ts').getProviderStore()
  return {
    store, load, replies, requests,
    setSetup(value: boolean) { setup = value },
    get invalidations() { return invalidations },
    async invoke(path: string, event: Event = {}) {
      const loginProvider = /^providers\/(codex|claude|antigravity)-login\//.exec(path)?.[1]
      const routeRoot = loginProvider
        ? `builtin/provider-${loginProvider === 'claude' ? 'claude-subscription' : loginProvider}/server/api/hub`
        : 'server/api/hub'
      return JSON.parse(JSON.stringify(await load(`${routeRoot}/${path}.ts`).default(event)))
    }
  }
}
function fixture(protocol: string) {
  return { name: protocol, protocol, enabled: true, models: [], connection: {
    ...Object.fromEntries(confidential.map(field => [field, `secret-${field}`])),
    base_url: 'https://upstream.example', timeout: 30000, max_retries: 3,
    token_expires_at: Date.now() + 3600000
  } }
}
function assertSanitized(provider: any) {
  for (const field of confidential) assert.equal(Object.hasOwn(provider.connection, field), false, field)
  assert.equal(provider.connection.authenticated, true)
}
async function status(operation: Promise<unknown>, statusCode: number, message?: string) {
  await assert.rejects(operation, (error: any) => {
    assert.equal(error.statusCode, statusCode)
    if (message) assert.equal(error.message, message)
    return true
  })
}

for (const protocol of protocols) {
  test(`${protocol}: CRUD reads/updates redact secrets; empty edit retains credentials; delete and missing shapes`, async () => {
    const context = harness()
    if (protocol.endsWith('-subscription')) await context.store.create(fixture(protocol))
    else {
      const created = await context.invoke('providers.post', { body: { name: protocol, protocol, api_key: 'secret-api_key' } })
      assert.equal(created.success, true)
      assertSanitized(created.provider)
      await context.store.update(protocol, { connection: fixture(protocol).connection })
    }
    const original = await context.store.get(protocol)
    assertSanitized((await context.invoke('providers/[name].get', { name: protocol })).provider)
    const listed = await context.invoke('providers.get')
    assert.deepEqual(Object.keys(listed), ['providers'])
    assert.equal(listed.providers.length, 1)
    assertSanitized(listed.providers[0])
    const body: any = { name: 'cannot-rename', display_name: 'Edited', api_key: '', timeout: 0, max_retries: 0, enable_timeout: false }
    if (protocol.endsWith('-subscription')) body.connection = {
      ...Object.fromEntries(confidential.map(field => [field, 'injected'])),
      base_url: 'https://ignored.example', token_expires_at: 1
    }
    const updated = await context.invoke('providers/[name].put', { name: protocol, body })
    assert.equal(updated.success, true)
    assertSanitized(updated.provider)
    assert.equal(updated.provider.name, protocol)
    assert.equal(updated.provider.display_name, 'Edited')
    const saved = await context.store.get(protocol)
    for (const field of confidential) assert.equal(saved.connection[field], original.connection[field], field)
    assert.equal(saved.connection.timeout, 0)
    assert.equal(saved.connection.max_retries, 0)
    assert.equal(saved.connection.enable_timeout, false)
    if (protocol.endsWith('-subscription')) {
      assert.equal(saved.connection.base_url, original.connection.base_url)
      assert.equal(saved.connection.token_expires_at, original.connection.token_expires_at)
    }
    assert.deepEqual(await context.invoke('providers/[name].delete', { name: protocol }), { success: true })
    assert.equal(await context.store.get(protocol), null)
    for (const method of ['get', 'delete', 'put']) await status(context.invoke(`providers/[name].${method}`, { name: protocol, body: {} }), 404, 'Provider not found')
    assert.equal(context.invalidations, protocol.endsWith('-subscription') ? 2 : 3)
  })
}

test('provider creation defaults, duplicate, validation ordering and subscription creation gates', async () => {
  const context = harness()
  const created = await context.invoke('providers.post', { body: { name: 'default', timeout: 0, max_retries: 0 } })
  assert.deepEqual(created, { success: true, provider: {
    name: 'default', display_name: 'default', protocol: 'openai', enabled: true, use_custom_models: false,
    connection: { base_url: '', timeout: 30000, enable_timeout: true, max_retries: 3, api_type: 'responses', authenticated: false },
    models: [], defaults: { temperature: 0.7, max_tokens: 4096 }
  } })
  await status(context.invoke('providers.post', { body: { name: 'default' } }), 409, "Provider 'default' already exists")
  await status(context.invoke('providers.post', { body: {} }), 400, 'Provider name is required')
  await status(context.invoke('providers.post', { body: { name: 'bad', protocol: 'missing' } }), 400, 'Provider type is not registered')
  for (const body of [{ api_type: 'bad', connection: { api_type: 'responses' } }, { api_type: 'responses', connection: { api_type: 'bad' } }]) {
    for (const route of ['providers.post', 'providers/[name].put']) await status(context.invoke(route, { name: 'default', body: { name: 'bad', ...body } }), 400, 'Invalid API protocol: api_type must be responses or chat_completions')
  }
  for (const [protocol, brand] of [['codex-subscription', 'ChatGPT'], ['claude-subscription', 'Claude'], ['antigravity-subscription', 'Google']]) {
    for (const route of ['providers.post', 'providers/[name].put']) await status(context.invoke(route, { name: 'default', body: { name: 'bad', protocol } }), 400,
      `Use Connect ${brand} to add ${protocol === 'antigravity-subscription' ? 'an Antigravity' : protocol === 'codex-subscription' ? 'a Codex' : 'a Claude'} Subscription provider`)
  }
  await status(context.invoke('providers.post', { body: { name: 'private', base_url: 'http://127.0.0.1' } }), 400)
  await status(context.invoke('providers/[name].put', { name: 'default', body: { base_url: 'https://valid.example', connection: { base_url: 'http://127.0.0.1' } } }), 400)
  assert.equal((await context.store.getAll()).length, 1)
})

for (const protocol of ['codex', 'claude', 'antigravity']) {
  const complete = protocol === 'codex' ? 'poll' : 'complete'
  const start = `providers/${protocol}-login/start.post`
  const finish = `providers/${protocol}-login/[id]/${complete}.post`
  const cancel = `providers/${protocol}-login/[id].delete`
  function queueStart(context: ReturnType<typeof harness>) {
    if (protocol === 'codex') context.replies.push({ match: '/deviceauth/usercode', body: { device_auth_id: 'private-device', user_code: 'ABCD', interval: 1 } })
  }
  test(`${protocol} login: setup/validation/not-found, pending, conflict, cancellation and rate limit shapes`, async () => {
    const context = harness()
    context.setSetup(false)
    for (const route of [start, finish, cancel]) await status(context.invoke(route), 403)
    context.setSetup(true)
    for (const name of ['', 'Bad Name']) await status(context.invoke(start, { body: { name } }), 400)
    for (const route of [finish, cancel]) {
      await status(context.invoke(route), 400, 'Login ID is required')
      await status(context.invoke(route, { id: 'missing', body: {} }), 404)
    }
    for (let index = 0; index < 3; index++) {
      queueStart(context)
      const pending = await context.invoke(start, { body: { name: `login-${index}` } })
      assert.deepEqual(Object.keys(pending).sort(), (protocol === 'codex'
        ? ['login_id', 'status', 'verification_url', 'user_code', 'expires_at']
        : ['login_id', 'status', 'authorization_url', 'expires_at']).sort())
      assert.equal(pending.status, 'pending')
      assert.equal(typeof pending.login_id, 'string')
      assert.equal(typeof pending.expires_at, 'number')
      if (index === 0) {
        await status(context.invoke(start, { body: { name: 'another' } }), 409)
        await status(context.invoke(finish, { id: pending.login_id, actor: 'other-admin', body: { code: 'code' } }), 404)
        if (protocol !== 'codex') await status(context.invoke(finish, { id: pending.login_id, body: {} }), 400, protocol === 'antigravity' ? 'Google callback URL is required' : 'Authorization code is required')
        else {
          context.replies.push({ match: '/deviceauth/token', status: 403, body: {} })
          assert.deepEqual(await context.invoke(finish, { id: pending.login_id }), pending)
        }
      }
      assert.deepEqual(await context.invoke(cancel, { id: pending.login_id }), { status: 'cancelled' })
      assert.deepEqual(await context.invoke(cancel, { id: pending.login_id }), { status: 'cancelled' })
      assert.equal((await context.invoke(finish, { id: pending.login_id, body: {} })).status, 'cancelled')
    }
    await status(context.invoke(start, { body: { name: 'limited' } }), 429, 'Too many login attempts. Try again in a few minutes.')
    assert.equal(context.replies.length, 0)
    assert.equal((await context.store.getAll()).length, 0)
  })
  test(`${protocol} login: real OAuth clients with mock HTTP yield completed sanitized provider or failed session`, async () => {
    for (const failure of [false, true]) {
      const context = harness()
      queueStart(context)
      const pending = await context.invoke(start, { body: { name: 'connected', timeout: 0, max_retries: 0 } })
      if (protocol === 'codex') context.replies.push({ match: '/deviceauth/token', body: { authorization_code: 'code', code_verifier: 'private-verifier' } })
      context.replies.push({ match: protocol === 'antigravity' ? 'oauth2.googleapis.com/token' : '/oauth/token',
        ...(failure ? { status: 400, body: { error_description: 'mock exchange rejected' } } : {
          body: { access_token: 'private-access', refresh_token: 'private-refresh', id_token: 'private-id', expires_in: 3600 }
        }) })
      if (protocol === 'antigravity' && !failure) context.replies.push(
        { match: ':loadCodeAssist', body: { cloudaicompanionProject: 'private-project' } },
        { match: 'userinfo', body: { email: 'test@example.invalid' } }
      )
      const code = protocol === 'antigravity'
        ? `http://localhost:8086/?code=code&state=${new URL(pending.authorization_url).searchParams.get('state')}`
        : 'code'
      const result = await context.invoke(finish, { id: pending.login_id, body: { code } })
      assert.equal(result.status, failure ? 'failed' : 'completed')
      assert.deepEqual(Object.keys(result).sort(), [...Object.keys(pending), failure ? 'error' : 'provider'].sort())
      if (failure) {
        assert.equal(result.error, 'mock exchange rejected')
        assert.equal(await context.store.get('connected'), null)
      } else {
        assertSanitized(result.provider)
        assert.equal(result.provider.protocol, `${protocol}-subscription`)
        const saved = await context.store.get('connected')
        assert.equal(saved.connection.api_key, 'private-access')
        assert.equal(saved.connection.refresh_token, 'private-refresh')
        assert.equal(saved.connection.timeout, protocol === 'antigravity' ? 120000 : 30000)
        assert.equal(saved.connection.max_retries, 3)
        assert.equal(context.invalidations, 1)
      }
      assert.deepEqual(await context.invoke(finish, { id: pending.login_id, body: { code: 'again' } }), result)
      assert.equal(context.replies.length, 0)
    }
  })
}

test('subscription routes reject absent/unknown names and every unsupported protocol before network', async () => {
  const context = harness()
  for (const route of ['subscription-usage.get', 'subscription-reset.post']) {
    await status(context.invoke(`providers/[name]/${route}`), 400, 'Provider name is required')
    await status(context.invoke(`providers/[name]/${route}`, { name: 'missing' }), 404, 'Provider not found')
  }
  for (const protocol of [...protocols, 'unavailable-plugin']) {
    await context.store.create(fixture(protocol))
    if (!protocol.endsWith('-subscription')) await status(context.invoke('providers/[name]/subscription-usage.get', { name: protocol }), 400, 'Provider does not use a supported subscription')
    if (protocol !== 'codex-subscription') await status(context.invoke('providers/[name]/subscription-reset.post', { name: protocol }), 400, 'Provider does not use a Codex subscription')
  }
  assert.equal(context.requests.length, 0)
})

for (const protocol of protocols.filter(protocol => protocol.endsWith('-subscription'))) {
  test(`${protocol}: usage response/cache/refresh and upstream failure status`, async () => {
    const context = harness()
    await context.store.create(fixture(protocol))
    const match = protocol === 'codex-subscription' ? '/wham/usage' : protocol === 'claude-subscription' ? '/api/oauth/usage' : ':fetchAvailableModels'
    const body = protocol === 'codex-subscription' ? { rate_limit: { primary_window: { used_percent: 25 } } }
      : protocol === 'claude-subscription' ? { five_hour: { utilization: 25 } }
      : { models: { model: { quotaInfo: { remainingFraction: 0.75 } } } }
    function queue() {
      context.replies.push({ match, body })
      if (protocol === 'codex-subscription') context.replies.push({ match: '/rate-limit-reset-credits', body: {} })
    }
    queue()
    const result = await context.invoke('providers/[name]/subscription-usage.get', { name: protocol })
    assert.equal(result.provider, protocol)
    assert.equal(result.protocol, protocol)
    assert.equal(result.windows.length, 1)
    assert.equal(result.windows[0].used_percent, 25)
    assert.ok(Number.isFinite(Date.parse(result.fetched_at)))
    assert.equal(JSON.stringify(result).includes('secret-'), false)
    for (const refresh of [undefined, 'false', true]) assert.deepEqual(await context.invoke('providers/[name]/subscription-usage.get', { name: protocol, query: { refresh } }), result)
    for (const refresh of ['1', 'true']) {
      queue()
      assert.equal((await context.invoke('providers/[name]/subscription-usage.get', { name: protocol, query: { refresh } })).windows[0].used_percent, 25)
    }
    assert.equal(context.replies.length, 0)
    // Antigravity has multi-host retry behavior, covered in its adapter suite.
    if (protocol !== 'antigravity-subscription') {
      context.replies.push({ match, status: 401, body: { error: { message: 'usage denied' } } })
      await status(context.invoke('providers/[name]/subscription-usage.get', { name: protocol, query: { refresh: 'true' } }), 401)
    }
  })
}

test('Codex reset trims optional credit id, generates idempotency key, normalizes shape and propagates errors', async () => {
  const context = harness()
  await context.store.create(fixture('codex-subscription'))
  for (const credit of ['  credit-1  ', '', 7, undefined]) {
    context.replies.push({ match: '/rate-limit-reset-credits/consume', body: { code: 'ok', windows_reset: 2, private: 'omitted' } })
    assert.deepEqual(await context.invoke('providers/[name]/subscription-reset.post', { name: 'codex-subscription', body: { credit_id: credit } }), { code: 'ok', windows_reset: 2 })
    const request = context.requests.at(-1)!
    assert.equal(request.options.method, 'POST')
    const payload = JSON.parse(request.options.body)
    assert.match(payload.redeem_request_id, /^[0-9a-f-]{36}$/)
    assert.deepEqual(Object.keys(payload).sort(), (credit === '  credit-1  ' ? ['credit_id', 'redeem_request_id'] : ['redeem_request_id']).sort())
    if (credit === '  credit-1  ') assert.equal(payload.credit_id, 'credit-1')
  }
  context.replies.push({ match: '/consume', status: 409, body: { error: { message: 'already redeemed' } } })
  await status(context.invoke('providers/[name]/subscription-reset.post', { name: 'codex-subscription', body: {} }), 409)
})

test('plugin CRUD validates schema defaults, retains empty secrets and fails closed after unload', async () => {
  const context = harness()
  const registry = context.load('server/core/registry.ts').providerRegistry
  const unregister = registry.register({
    id: 'test-plugin', secretConnectionFields: ['extra.private_text'],
    connectionSchema: [
      { key: 'token', type: 'secret', required: true },
      { key: 'private_text', type: 'text' },
      { key: 'region', type: 'select', options: [{ value: 'eu', label: 'Europe' }], default: 'eu' },
      { key: 'count', type: 'number', default: 2 },
      { key: 'active', type: 'boolean', default: true }
    ],
    createAdapter() { throw new Error('CRUD must not construct adapters') },
    fetchModels() { throw new Error('CRUD must not discover models') }
  })
  for (const extra of [null, [], {}, { token: 'value', unknown: 1 }, { token: 'value', count: '2' }, { token: 'value', active: 1 }, { token: 'value', region: 'invalid' }]) {
    await status(context.invoke('providers.post', { body: { name: 'plugin', protocol: 'test-plugin', connection: { extra } } }), 400)
  }
  const created = await context.invoke('providers.post', { body: { name: 'plugin', protocol: 'test-plugin',
    connection: { api_key: 'private-api', base_url: 'https://plugin.example', extra: { token: 'private-token', private_text: 'private-text' } }
  } })
  assertSanitized(created.provider)
  assert.deepEqual(created.provider.connection.extra, { region: 'eu', count: 2, active: true })
  const updated = await context.invoke('providers/[name].put', { name: 'plugin', body: {
    connection: { api_key: '', extra: { token: '', private_text: '', count: 0, active: false } }
  } })
  assertSanitized(updated.provider)
  assert.deepEqual(updated.provider.connection.extra, { region: 'eu', count: 0, active: false })
  const saved = await context.store.get('plugin')
  assert.equal(saved.connection.api_key, 'private-api')
  assert.equal(saved.connection.extra.token, 'private-token')
  assert.equal(saved.connection.extra.private_text, 'private-text')
  unregister()
  const missing = (await context.invoke('providers.get')).providers[0]
  assert.equal(missing.available, false)
  assert.equal(missing.unavailableReason, 'Provider plugin is not loaded')
  assert.deepEqual(missing.connection.extra, {})
  assert.deepEqual((await context.invoke('providers/[name].get', { name: 'plugin' })).provider.connection.extra, {})
  await status(context.invoke('providers/[name].put', { name: 'plugin', body: {} }), 400, 'Provider type is not registered')
  assert.deepEqual(await context.invoke('providers/[name].delete', { name: 'plugin' }), { success: true })
})

test('successful Codex reset invalidates usage cache, and empty upstream response has stable defaults', async () => {
  const context = harness()
  const name = 'codex-subscription'
  await context.store.create(fixture(name))
  function queueUsage(percent: number) {
    context.replies.push(
      { match: '/wham/usage', body: { rate_limit: { primary_window: { used_percent: percent } } } },
      { match: '/rate-limit-reset-credits', body: {} }
    )
  }
  queueUsage(100)
  assert.equal((await context.invoke('providers/[name]/subscription-usage.get', { name })).windows[0].used_percent, 100)
  context.replies.push({ match: '/consume', body: {} })
  assert.deepEqual(await context.invoke('providers/[name]/subscription-reset.post', { name }), { code: 'unknown', windows_reset: 0 })
  queueUsage(0)
  assert.equal((await context.invoke('providers/[name]/subscription-usage.get', { name })).windows[0].used_percent, 0)
  assert.equal(context.replies.length, 0)
})
