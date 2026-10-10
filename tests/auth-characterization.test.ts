import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

type Protocol = 'openai' | 'claude' | 'gemini'
type KeyRecord = {
  name: string
  tokens_used: number
  monthly_limit: number
  allowed_providers: string[]
  allowed_models: string[]
  model_quotas: Record<string, number>
  model_usage: Record<string, number>
  provider_quotas: Record<string, number>
  provider_usage: Record<string, number>
  fallback_strategy: { enabled: boolean; name: string; priority: string[] }
}
type Options = {
  method?: string; path?: string; model?: unknown; headers?: Record<string, string>
  record?: Partial<KeyRecord>; invalidKey?: boolean; session?: boolean
  impersonated?: boolean; rateDenied?: boolean; bodyFailure?: boolean
  ipHeader?: string; clientAddress?: string
}
const adminRecord: KeyRecord = {
  name: 'Gateway Session', tokens_used: 0, monthly_limit: 0,
  allowed_providers: [], allowed_models: [], model_quotas: {}, model_usage: {},
  provider_quotas: {}, provider_usage: {},
  fallback_strategy: { enabled: false, name: 'auto', priority: [] }
}

// Follow the existing VM route-test facility: execute real middleware and fallback,
// replace only H3 transport and storage. No credentials, disk store or network.
// Transpilation is in memory, so no build artifacts are written to the repository.
const sources = new Map<string, string>()
function compiled(path: string): string {
  if (!sources.has(path)) sources.set(path, ts.transpileModule(
    readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText)
  return sources.get(path)!
}
async function invoke(protocol: Protocol, options: Options = {}) {
  const calls: string[] = []
  const record: KeyRecord = { ...structuredClone(adminRecord), name: 'Test key', ...options.record }
  const model = options.model === undefined ? 'provider/model' : options.model
  const path = options.path ?? (protocol === 'gemini'
    ? `/api/gemini/v1beta/models/${encodeURIComponent(String(model))}:generateContent`
    : `/api/${protocol}/v1/${protocol === 'openai' ? 'chat/completions' : 'messages'}`)
  const headers = Object.fromEntries(Object.entries(options.headers ?? { authorization: 'Bearer valid' })
    .map(([name, value]) => [name.toLowerCase(), value]))
  const event = {
    path, method: options.method ?? 'POST', body: { model },
    context: { ...(options.clientAddress ? { clientAddress: options.clientAddress } : {}) } as Record<string, unknown>
  }
  let status = 200
  let responseBody: string | undefined
  const responseHeaders: Record<string, string> = {}
  const store = {
    async getBruteForceConfig() { calls.push('config'); return { ip_header: options.ipHeader } },
    async getKeyRecord(key: string) { calls.push(`key:${key}`); return options.invalidKey ? null : record },
    async validateSession(token: string) { calls.push(`session:${token}`); return !!options.session },
    async getKeyById(id: string) { calls.push(`impersonate:${id}`); return options.impersonated ? record : null }
  }
  const transport = {
    getHeader: (_event: unknown, name: string) => headers[name.toLowerCase()],
    readBody: async () => { calls.push('body'); if (options.bodyFailure) throw new Error('Malformed JSON'); return event.body },
    getRequestURL: () => { calls.push('url'); return new URL(path, 'http://offline.invalid') },
    setResponseStatus: (_event: unknown, value: number) => { status = value },
    setResponseHeader: (_event: unknown, name: string, value: string) => { responseHeaders[name] = value },
    send: (_event: unknown, value: string) => { responseBody = value; return value }
  }
  function execute(path: string, imports: Record<string, unknown>): any {
    const module = { exports: {} }
    runInNewContext(compiled(path), {
      module, exports: module.exports,
      defineEventHandler: (handler: unknown) => handler,
      getCookie: (_event: unknown, name: string) => { assert.equal(name, 'llmhub_session'); calls.push('cookie'); return headers.cookie },
      require: (name: string) => { assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`); return imports[name] }
    }, { filename: path })
    return module.exports
  }
  if (process.env.CHARACTERIZATION_BASELINE === '1') {
    const fallback = execute('server/utils/fallback.ts', {})
    const middleware = execute(`server/middleware/${protocol}-auth.ts`, {
      h3: transport,
      '../stores/auth.store': { getAuthStore: () => ({ ...store,
        async checkRateLimit(ip: string) {
          calls.push(`rate:${ip}`)
          return { allowed: !options.rateDenied, retryAfter: 17 }
        }
      }) },
      '../utils/fallback': fallback
    }).default
    await middleware(event)
    return { event, calls, record, status, responseBody, responseHeaders }
  }
  const hooks = execute('server/core/hooks.ts', {})
  const fallback = execute('builtin/fallback/service.ts', {})
  const plugins = [
    ['rate-limit', { h3: transport, '../../server/stores/auth.store': { getAuthStore: () => store },
      './service': { async checkRateLimit(ip: string) {
        calls.push(`rate:${ip}`)
        return { allowed: !options.rateDenied, retryAfter: 17 }
      } } }],
    ['fallback', { './service': fallback }],
    ['access-control', {}],
    ['quota', { './service': { addUsage() { throw new Error('Admission must not account usage') } } }]
  ] as const
  for (const [name, imports] of plugins) {
    execute(`builtin/${name}/plugin.ts`, imports).default.setup({
      registerHook: (hook: any) => hooks.requestHooks.register({ ...hook, id: `${name}:${hook.id}` })
    })
  }
  const admission = execute('builtin/shared/ingress.ts', { h3: transport })
  const { IngressRegistry } = execute('server/core/ingress-registry.ts', {})
  const ingressRegistry = new IngressRegistry()
  for (const family of ['openai', 'claude', 'gemini']) {
    const { ingress } = execute(`builtin/ingress-${family}/ingress.ts`, {
      h3: transport, '../shared/ingress': admission
    })
    ingressRegistry.register(ingress)
  }
  const middleware = execute('server/middleware/ingress-auth.ts', {
    h3: transport, '../stores/auth.store': { getAuthStore: () => store },
    '../core/hooks': hooks, '../core/ingress-registry': { ingressRegistry }
  }).default
  await middleware(event)
  return { event, calls, record, status, responseBody, responseHeaders }
}
type Outcome = Awaited<ReturnType<typeof invoke>>
function rejected(outcome: Outcome, status: number, message: string, code = 'invalid_api_key') {
  assert.equal(outcome.status, status)
  assert.deepEqual(outcome.responseHeaders, { 'Content-Type': 'application/json' })
  assert.equal(outcome.responseBody, JSON.stringify({ error: { message, type: 'authentication_error', code } }))
  assert.equal(outcome.event.context._apiKeyRecord, undefined)
  assert.equal(outcome.event.context._resolvedModel, undefined)
}
function accepted(outcome: Outcome) {
  assert.equal(outcome.status, 200)
  assert.equal(outcome.responseBody, undefined)
  assert.deepEqual(outcome.responseHeaders, {})
  assert.equal(outcome.event.context._apiKeyRecord, outcome.record)
}
const exhausted: Partial<KeyRecord> = {
  monthly_limit: 10, tokens_used: 10, allowed_models: ['other'],
  model_quotas: { 'provider/model': 4 }, model_usage: { 'provider/model': 4 },
  provider_quotas: { provider: 8 }, provider_usage: { provider: 8 }
}
for (const protocol of ['openai', 'claude', 'gemini'] as const) {
  const prefix = ['config', 'rate:127.0.0.1']
  const modelRead = protocol === 'gemini' ? 'url' : 'body'
  test(`${protocol}: unrelated paths have no auth side effects`, async () => {
    const outcome = await invoke(protocol, { path: '/api/unrelated', headers: {} })
    assert.deepEqual(outcome.calls, [])
    assert.deepEqual(outcome.event.context, {})
    assert.equal(outcome.responseBody, undefined)
  })
  test(`${protocol}: rate limit precedes key, cookie, monthly and model checks`, async () => {
    const outcome = await invoke(protocol, { rateDenied: true, invalidKey: true, record: exhausted })
    rejected(outcome, 429, 'Rate limit exceeded. Retry after 17s.', 'rate_limit_exceeded')
    assert.deepEqual(outcome.calls, prefix)
  })
  test(`${protocol}: missing key rejection has the complete protocol-specific body`, async () => {
    const outcome = await invoke(protocol, { headers: {} })
    rejected(outcome, 401, protocol === 'gemini'
      ? 'API Key required. Provide via x-goog-api-key header or Authorization: Bearer <key>.'
      : 'API Key required. Provide via Authorization: Bearer <key> or X-API-Key header.')
    assert.deepEqual(outcome.calls, [...prefix, 'cookie'])
  })
  test(`${protocol}: invalid key does not fall back to valid admin session`, async () => {
    const outcome = await invoke(protocol, { invalidKey: true, session: true, headers: { authorization: 'Bearer invalid', cookie: 'admin' }, record: exhausted })
    rejected(outcome, 401, 'Invalid API Key')
    assert.deepEqual(outcome.calls, [...prefix, 'key:invalid'])
  })
  test(`${protocol}: monthly quota precedes model parsing/access`, async () => {
    const outcome = await invoke(protocol, { record: exhausted, bodyFailure: true })
    rejected(outcome, 429, 'Monthly token quota (10) exceeded.', 'quota_exceeded')
    assert.deepEqual(outcome.calls, [...prefix, 'key:valid'])
  })
  test(`${protocol}: access precedes per-model and provider quotas`, async () => {
    const outcome = await invoke(protocol, { record: { ...exhausted, monthly_limit: 0 } })
    rejected(outcome, 403, 'Model "provider/model" is not allowed for this API key.', 'access_denied')
    assert.deepEqual(outcome.calls, [...prefix, 'key:valid', modelRead])
  })
  test(`${protocol}: per-model quota precedes provider quota`, async () => {
    const outcome = await invoke(protocol, { record: { ...exhausted, monthly_limit: 0, allowed_models: [] } })
    rejected(outcome, 429, 'Model "provider/model" quota (4) exceeded.', 'model_quota_exceeded')
  })
  test(`${protocol}: provider quota complete rejection`, async () => {
    const outcome = await invoke(protocol, { record: { ...exhausted, monthly_limit: 0, allowed_models: [], model_quotas: {} } })
    rejected(outcome, 429, 'Provider "provider" quota (8) exceeded.', 'provider_quota_exceeded')
  })
  test(`${protocol}: GET models authenticates but skips rate/monthly/model checks`, async () => {
    const path = `/api/${protocol}/v1/models`
    const outcome = await invoke(protocol, { method: 'GET', path, record: exhausted, rateDenied: true })
    accepted(outcome)
    assert.deepEqual(outcome.calls, ['key:valid'])
    assert.equal(outcome.event.context._resolvedModel, undefined)
    rejected(await invoke(protocol, { method: 'GET', path, invalidKey: true }), 401, 'Invalid API Key')
  })
  test(`${protocol}: provider and model allowlists are OR, matching is exact`, async () => {
    for (const record of [{ allowed_providers: ['provider'], allowed_models: ['other'] }, { allowed_providers: ['other'], allowed_models: ['provider/model'] }]) {
      accepted(await invoke(protocol, { record }))
    }
    for (const model of ['model', 'provider-other/model', 'Provider/model']) {
      rejected(await invoke(protocol, { model, record: { allowed_providers: ['provider'] } }), 403, `Model "${model}" is not allowed for this API key.`, 'access_denied')
    }
  })
  test(`${protocol}: fallback skips exhausted model/provider and rewrites at the current ownership boundary`, async () => {
    const outcome = await invoke(protocol, { model: 'auto', record: {
      fallback_strategy: { enabled: true, name: 'auto', priority: ['provider/full', 'blocked/model', 'provider/available'] },
      model_quotas: { 'provider/full': 1 }, model_usage: { 'provider/full': 1 },
      provider_quotas: { blocked: 2 }, provider_usage: { blocked: 2 }, allowed_models: ['provider/available']
    } })
    accepted(outcome)
    assert.equal(outcome.event.body.model, protocol === 'gemini' ? 'auto' : 'provider/available')
    assert.equal(outcome.event.context._resolvedModel, protocol === 'gemini' ? 'provider/available' : undefined)
    if (protocol === 'gemini') assert.equal(outcome.event.path, '/api/gemini/v1beta/models/auto:generateContent')
  })
  test(`${protocol}: fallback exhaustion precedes access denial`, async () => {
    rejected(await invoke(protocol, { model: 'auto', record: {
      fallback_strategy: { enabled: true, name: 'auto', priority: ['provider/model'] },
      model_quotas: { 'provider/model': 1 }, model_usage: { 'provider/model': 1 }, allowed_models: ['other']
    } }), 429, 'All fallback models exhausted.', 'fallback_exhausted')
  })
  test(`${protocol}: fallback does not filter by access; selected model is subsequently denied`, async () => {
    rejected(await invoke(protocol, { model: 'auto', record: {
      fallback_strategy: { enabled: true, name: 'auto', priority: ['denied/model', 'allowed/model'] }, allowed_models: ['allowed/model']
    } }), 403, 'Model "denied/model" is not allowed for this API key.', 'access_denied')
  })
  test(`${protocol}: empty or disabled fallback leaves alias subject to access rules`, async () => {
    for (const strategy of [{ enabled: true, name: 'auto', priority: [] }, { enabled: false, name: 'auto', priority: ['provider/model'] }]) {
      rejected(await invoke(protocol, { model: 'auto', record: { fallback_strategy: strategy, allowed_models: ['provider/model'] } }),
        403, 'Model "auto" is not allowed for this API key.', 'access_denied')
    }
  })
  test(`${protocol}: admin and unknown impersonation IDs retain full access and bypass model parsing`, async () => {
    for (const id of ['', 'missing']) {
      const outcome = await invoke(protocol, { session: true, headers: { cookie: 'admin', 'x-llmhub-key-id': id }, record: exhausted })
      assert.equal(outcome.responseBody, undefined)
      assert.deepEqual(JSON.parse(JSON.stringify(outcome.event.context._apiKeyRecord)), adminRecord)
      assert.equal(outcome.event.context._resolvedModel, undefined)
      assert.deepEqual(outcome.calls, [...prefix, 'cookie', 'session:admin', ...(id ? ['impersonate:missing'] : [])])
    }
  })
  test(`${protocol}: admin impersonation applies key quota and access restrictions`, async () => {
    const options = { session: true, impersonated: true, headers: { cookie: 'admin', 'x-llmhub-key-id': 'selected' } }
    const outcome = await invoke(protocol, { ...options, record: exhausted })
    rejected(outcome, 429, 'Monthly token quota (10) exceeded.', 'quota_exceeded')
    assert.deepEqual(outcome.calls, [...prefix, 'cookie', 'session:admin', 'impersonate:selected'])
    rejected(await invoke(protocol, { ...options, record: { allowed_models: ['other'] } }), 403,
      'Model "provider/model" is not allowed for this API key.', 'access_denied')
    accepted(await invoke(protocol, options))
  })
  test(`${protocol}: key credentials ignore impersonation headers`, async () => {
    const outcome = await invoke(protocol, { session: true, impersonated: true, headers: { authorization: 'Bearer valid', cookie: 'admin', 'x-llmhub-key-id': 'selected' } })
    accepted(outcome)
    assert.deepEqual(outcome.calls, [...prefix, 'key:valid', modelRead])
  })
  test(`${protocol}: invalid session is rejected before impersonation lookup`, async () => {
    const outcome = await invoke(protocol, { headers: { cookie: 'expired', 'x-llmhub-key-id': 'selected' }, impersonated: true })
    rejected(outcome, 401, protocol === 'gemini'
      ? 'API Key required. Provide via x-goog-api-key header or Authorization: Bearer <key>.'
      : 'API Key required. Provide via Authorization: Bearer <key> or X-API-Key header.')
    assert.deepEqual(outcome.calls, [...prefix, 'cookie', 'session:expired'])
  })
  test(`${protocol}: quota boundaries accept below limit and treat nonpositive limits as unlimited`, async () => {
    for (const limit of [0, -1, 11]) {
      accepted(await invoke(protocol, { record: {
        monthly_limit: limit, tokens_used: 10,
        model_quotas: { 'provider/model': limit }, model_usage: { 'provider/model': 10 },
        provider_quotas: { provider: limit }, provider_usage: { provider: 10 }
      } }))
    }
    accepted(await invoke(protocol, { record: {
      model_quotas: { 'provider/model': 1 }, provider_quotas: { provider: 1 }
    } }))
  })
  test(`${protocol}: non-POST methods authenticate but skip every quota and model check`, async () => {
    for (const method of ['HEAD', 'OPTIONS', 'PUT', 'DELETE']) {
      const outcome = await invoke(protocol, { method, record: exhausted, rateDenied: true, bodyFailure: true })
      accepted(outcome)
      assert.deepEqual(outcome.calls, ['key:valid'])
      assert.equal(outcome.event.context._resolvedModel, undefined)
    }
  })
  test(`${protocol}: prefix matching currently also authenticates sibling path names`, async () => {
    const outcome = await invoke(protocol, { path: `/api/${protocol}-sibling`, headers: {} })
    assert.equal(outcome.status, 401)
    assert.deepEqual(outcome.calls, [...prefix, 'cookie'])
  })
  test(`${protocol}: blank fallback name does not resolve the advertised default auto alias`, async () => {
    rejected(await invoke(protocol, { model: 'auto', record: {
      allowed_models: ['provider/model'],
      fallback_strategy: { enabled: true, name: '', priority: ['provider/model'] }
    } }), 403, 'Model "auto" is not allowed for this API key.', 'access_denied')
  })
  test(`${protocol}: IP header first entry, context and loopback fallback`, async () => {
    for (const [options, ip] of [
      [{ ipHeader: 'x-forwarded-for', headers: { authorization: 'Bearer valid', 'x-forwarded-for': ' 192.0.2.1 , 192.0.2.2' }, clientAddress: '192.0.2.3' }, '192.0.2.1'],
      [{ ipHeader: 'x-forwarded-for', clientAddress: '192.0.2.3' }, '192.0.2.3'],
      [{}, '127.0.0.1']
    ] as [Options, string][]) {
      const outcome = await invoke(protocol, options)
      assert.equal(outcome.calls[1], `rate:${ip}`)
    }
  })
}

for (const protocol of ['openai', 'claude'] as const) {
  test(`${protocol}: Bearer key wins over X-API-Key; keys are trimmed and scheme is case sensitive`, async () => {
    for (const [headers, key] of [
      [{ authorization: 'Bearer  primary ', 'x-api-key': 'secondary' }, 'primary'],
      [{ authorization: 'bearer ignored', 'x-api-key': ' secondary ' }, 'secondary'],
      [{ 'x-api-key': ' secondary ' }, 'secondary']
    ] as [Record<string, string>, string][]) {
      const outcome = await invoke(protocol, { headers })
      accepted(outcome)
      assert.ok(outcome.calls.includes(`key:${key}`))
    }
    const emptyBearer = await invoke(protocol, { headers: { authorization: 'Bearer   ', 'x-api-key': 'secondary' } })
    assert.equal(emptyBearer.status, 401)
    assert.ok(!emptyBearer.calls.some(call => call.startsWith('key:')))
  })
  test(`${protocol}: missing/empty model and malformed JSON bypass model checks after authentication`, async () => {
    for (const options of [{ model: null }, { model: '' }, { bodyFailure: true }]) {
      const outcome = await invoke(protocol, { ...options, record: { allowed_models: ['other'] } })
      accepted(outcome)
      assert.ok(outcome.calls.includes('body'))
    }
  })
  test(`${protocol}: POST models and embeddings use body model and enforce access`, async () => {
    for (const route of ['models', 'embeddings']) {
      const options = { path: `/api/${protocol}/v1/${route}`, record: { allowed_models: ['other'] } }
      rejected(await invoke(protocol, options), 403, 'Model "provider/model" is not allowed for this API key.', 'access_denied')
      accepted(await invoke(protocol, { ...options, model: null }))
    }
  })
}

test('gemini: Google header precedes Bearer; X-API-Key and query key are ignored', async () => {
  for (const [headers, key] of [
    [{ 'x-goog-api-key': ' google ', authorization: 'Bearer bearer' }, 'google'],
    [{ authorization: 'Bearer  bearer ' }, 'bearer'],
    [{ 'x-goog-api-key': '', authorization: 'Bearer bearer' }, 'bearer']
  ] as [Record<string, string>, string][]) {
    const outcome = await invoke('gemini', { headers })
    accepted(outcome)
    assert.ok(outcome.calls.includes(`key:${key}`))
  }
  for (const headers of [{ 'x-goog-api-key': '  ', authorization: 'Bearer bearer' }, { 'x-api-key': 'ignored' }, { authorization: 'bearer ignored' }]) {
    const outcome = await invoke('gemini', { headers, path: '/api/gemini/v1beta/models/provider%2Fmodel:generateContent?key=ignored' })
    rejected(outcome, 401, 'API Key required. Provide via x-goog-api-key header or Authorization: Bearer <key>.')
  }
})
test('gemini: four URL actions decode provider/model, ignore body model and query', async () => {
  for (const action of ['generateContent', 'streamGenerateContent', 'embedContent', 'batchEmbedContents']) {
    for (const encoded of ['provider%2Fmodel', 'provider/model']) {
      const options = { path: `/api/gemini/v1beta/models/${encoded}:${action}?model=other`, model: 'ignored/body', record: { allowed_models: ['provider/model'] } }
      const outcome = await invoke('gemini', options)
      accepted(outcome)
      assert.equal(outcome.event.context._resolvedModel, 'provider/model')
      assert.equal(outcome.event.body.model, 'ignored/body')
      assert.ok(!outcome.calls.includes('body'))
      rejected(await invoke('gemini', { ...options, record: { allowed_models: ['other'] } }), 403,
        'Model "provider/model" is not allowed for this API key.', 'access_denied')
    }
  }
})
test('gemini: models listing and unrecognized actions set empty resolved model on POST', async () => {
  for (const path of ['/api/gemini/v1beta/models', '/api/gemini/v1beta/models/provider%2Fmodel:countTokens']) {
    const outcome = await invoke('gemini', { path, record: { allowed_models: ['other'] } })
    accepted(outcome)
    assert.equal(outcome.event.context._resolvedModel, '')
  }
})
test('gemini: action regex currently accepts a recognized action prefix', async () => {
  const outcome = await invoke('gemini', { path: '/api/gemini/v1beta/models/provider%2Fmodel:generateContentSuffix' })
  accepted(outcome)
  assert.equal(outcome.event.context._resolvedModel, 'provider/model')
})
test('gemini: malformed model percent encoding currently throws URIError', async () => {
  await assert.rejects(invoke('gemini', { path: '/api/gemini/v1beta/models/%ZZ:generateContent' }),
    (error: Error) => error.name === 'URIError')
})
