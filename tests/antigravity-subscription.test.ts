import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) {
  console.error('ADAPTER_BUILD not set — run via tests/run-all.sh')
  process.exit(1)
}

process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = 'test-antigravity-client-id'
process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = 'test-antigravity-client-secret'

const { AntigravityAdapter } = require(`${buildDir}/providers/antigravity.js`)
const { ProviderStore } = require(`${buildDir}/stores/provider.store.js`)
const {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_REDIRECT_URI,
  createAntigravityAuthorization,
  discoverAntigravityAccount,
  exchangeAntigravityAuthorizationCode,
  parseAntigravityAuthorizationCode,
  refreshAntigravityTokens
} = require(`${buildDir}/utils/antigravity-auth.js`)

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

const config = {
  name: 'antigravity',
  display_name: 'Antigravity Subscription',
  protocol: 'antigravity-subscription',
  enabled: true,
  use_custom_models: false,
  connection: {
    base_url: 'https://daily-cloudcode-pa.googleapis.com',
    api_key: 'google-access',
    refresh_token: 'google-refresh',
    token_expires_at: Date.now() + 60 * 60 * 1000,
    project_id: 'cloud-project',
    account_email: 'person@example.com',
    timeout: 1000,
    enable_timeout: true,
    max_retries: 0
  },
  models: []
}

console.log('antigravity subscription oauth')

await test('authorization uses the installed Antigravity client and state', () => {
  const authorization = createAntigravityAuthorization()
  const url = new URL(authorization.authorization_url)
  assert.equal(url.origin, 'https://accounts.google.com')
  assert.equal(url.searchParams.get('client_id'), ANTIGRAVITY_CLIENT_ID)
  assert.equal(url.searchParams.get('redirect_uri'), ANTIGRAVITY_REDIRECT_URI)
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.match(url.searchParams.get('scope') || '', /cloud-platform/)
  assert.ok(authorization.state)
})

await test('callback URL validates state and extracts code', () => {
  assert.equal(
    parseAntigravityAuthorizationCode('http://localhost:8086/?code=auth-code&state=expected', 'expected'),
    'auth-code'
  )
  assert.throws(
    () => parseAntigravityAuthorizationCode('http://localhost:8086/?code=auth-code&state=other', 'expected'),
    /state did not match/
  )
  assert.throws(
    () => parseAntigravityAuthorizationCode('bare-code', 'expected'),
    /complete Google callback URL/
  )
})

await test('authorization exchange and refresh send form data', async () => {
  let exchangeBody = ''
  const exchanged = await exchangeAntigravityAuthorizationCode('auth-code', async (_url: string, init: RequestInit) => {
    exchangeBody = String(init.body)
    return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
  })
  assert.equal(new URLSearchParams(exchangeBody).get('redirect_uri'), ANTIGRAVITY_REDIRECT_URI)
  assert.equal(exchanged.refresh_token, 'refresh')

  let refreshBody = ''
  const refreshed = await refreshAntigravityTokens('refresh', async (_url: string, init: RequestInit) => {
    refreshBody = String(init.body)
    return Response.json({ access_token: 'new-access', expires_in: 1800 })
  })
  assert.equal(new URLSearchParams(refreshBody).get('grant_type'), 'refresh_token')
  assert.equal(refreshed.access_token, 'new-access')
})

await test('project discovery accepts loadCodeAssist project object', async () => {
  const account = await discoverAntigravityAccount('access', async (url: string, init: RequestInit) => {
    assert.match(url, /v1internal:loadCodeAssist$/)
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer access')
    return Response.json({
      cloudaicompanionProject: { id: 'project-123' },
      manageSubscriptionUri: 'https://example.test/?Email=person%40example.com',
      paidTier: { name: 'Google AI Pro' }
    })
  })
  assert.deepEqual(account, { projectId: 'project-123', email: 'person@example.com', tier: 'Google AI Pro' })
})

await test('project discovery onboards accounts without a project', async () => {
  const calls: Array<{ url: string; body: any }> = []
  const account = await discoverAntigravityAccount('access', async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined })
    if (url.includes('loadCodeAssist')) {
      return Response.json({
        manageSubscriptionUri: 'https://example.test/?Email=new%40example.com',
        allowedTiers: [{ id: 'free-tier', isDefault: true }]
      })
    }
    return Response.json({ done: true, response: { cloudaicompanionProject: { id: 'new-project' } } })
  })
  assert.equal(calls[1].url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser')
  assert.equal(calls[1].body.tier_id, 'free-tier')
  assert.equal(calls[1].body.metadata.ide_type, 'ANTIGRAVITY')
  assert.equal(account.projectId, 'new-project')
})

await test('provider responses hide OAuth and Google account identifiers', () => {
  const sanitized = new ProviderStore().sanitize(config)
  assert.equal(sanitized.connection.authenticated, true)
  assert.equal('api_key' in sanitized.connection, false)
  assert.equal('refresh_token' in sanitized.connection, false)
  assert.equal('project_id' in sanitized.connection, false)
  assert.equal('account_email' in sanitized.connection, false)
})

console.log('antigravity adapter')

await test('adapter wraps Gemini payload and unwraps non-stream response', async () => {
  const originalFetch = globalThis.fetch
  let captured: any
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) }
    return Response.json({
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'hello back' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 }
      }
    })
  }) as any

  try {
    const adapter = new AntigravityAdapter(config)
    const request = adapter.toProviderRequest({
      model: 'antigravity/gemini-3-flash',
      messages: [{ role: 'user', content: 'hello' }],
      config: { maxTokens: 100 },
      stream: false
    })
    const response = await adapter.call(request)
    assert.match(captured.url, /v1internal:generateContent$/)
    assert.equal(captured.headers.Authorization, 'Bearer google-access')
    assert.equal(captured.body.project, 'cloud-project')
    assert.equal(captured.body.model, 'gemini-3-flash')
    assert.equal(captured.body.request.contents[0].parts[0].text, 'hello')
    assert.match(captured.body.requestId, /^agent-/)
    assert.equal(response.candidates[0].content.parts[0].text, 'hello back')
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('adapter unwraps SSE envelopes and adds a terminal chunk on clean EOF', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]}}]}}\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } }
  )) as any

  try {
    const adapter = new AntigravityAdapter(config)
    const stream = adapter.callStream({
      modelId: 'gemini-3-flash',
      payload: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }
    })
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let output = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      output += decoder.decode(value, { stream: true })
    }
    assert.match(output, /"text":"hello"/)
    assert.match(output, /"finishReason":"STOP"/)
    assert.doesNotMatch(output, /"response"/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

console.log(`\n${passed} Antigravity subscription test groups passed${process.exitCode ? ', with FAILURES' : ''}`)
