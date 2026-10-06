import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) {
  console.error('ADAPTER_BUILD not set — run via tests/run-all.sh')
  process.exit(1)
}

process.env.GEMINI_CLI_OAUTH_CLIENT_ID = 'test-gemini-cli-client-id'
process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET = 'test-gemini-cli-client-secret'

const { GeminiCliAdapter, wrapGeminiCliRequest } = require(`${buildDir}/providers/gemini-cli.js`)
const { ProviderStore } = require(`${buildDir}/stores/provider.store.js`)
const {
  GEMINI_CLI_CLIENT_ID,
  GEMINI_CLI_REDIRECT_URI,
  createGeminiCliAuthorization,
  exchangeGeminiCliAuthorizationCode,
  fetchGeminiCliIdentity,
  parseGeminiCliAuthorizationCode,
  refreshGeminiCliTokens
} = require(`${buildDir}/utils/gemini-cli-auth.js`)

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
  name: 'gemini-cli',
  display_name: 'Gemini CLI Subscription',
  protocol: 'gemini-cli-subscription',
  enabled: true,
  use_custom_models: false,
  connection: {
    base_url: 'https://cloudcode-pa.googleapis.com',
    api_key: 'google-access',
    refresh_token: 'google-refresh',
    token_expires_at: Date.now() + 60 * 60 * 1000,
    project_id: 'managed-project',
    account_email: 'person@example.com',
    timeout: 1000,
    enable_timeout: true,
    max_retries: 0
  },
  models: []
}

console.log('gemini cli subscription oauth')

await test('authorization mirrors Gemini CLI installed-app OAuth', () => {
  const authorization = createGeminiCliAuthorization()
  const url = new URL(authorization.authorization_url)
  assert.equal(url.searchParams.get('client_id'), GEMINI_CLI_CLIENT_ID)
  assert.equal(url.searchParams.get('redirect_uri'), GEMINI_CLI_REDIRECT_URI)
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.match(url.searchParams.get('scope') || '', /userinfo.profile/)
  assert.ok(authorization.state)
})

await test('callback URL requires the loopback path and matching state', () => {
  assert.equal(
    parseGeminiCliAuthorizationCode(`${GEMINI_CLI_REDIRECT_URI}?code=auth-code&state=expected`, 'expected'),
    'auth-code'
  )
  assert.throws(
    () => parseGeminiCliAuthorizationCode('http://127.0.0.1:8085/wrong?code=x&state=expected', 'expected'),
    /must start/
  )
  assert.throws(
    () => parseGeminiCliAuthorizationCode(`${GEMINI_CLI_REDIRECT_URI}?code=x&state=wrong`, 'expected'),
    /state did not match/
  )
})

await test('token exchange and refresh use Gemini CLI client credentials', async () => {
  let exchangeBody = ''
  const tokens = await exchangeGeminiCliAuthorizationCode('code', async (_url: string, init: RequestInit) => {
    exchangeBody = String(init.body)
    return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
  })
  assert.equal(new URLSearchParams(exchangeBody).get('client_id'), GEMINI_CLI_CLIENT_ID)
  assert.equal(new URLSearchParams(exchangeBody).get('redirect_uri'), GEMINI_CLI_REDIRECT_URI)
  assert.equal(tokens.refresh_token, 'refresh')

  let refreshBody = ''
  await refreshGeminiCliTokens('refresh', async (_url: string, init: RequestInit) => {
    refreshBody = String(init.body)
    return Response.json({ access_token: 'new-access', expires_in: 3600 })
  })
  assert.equal(new URLSearchParams(refreshBody).get('grant_type'), 'refresh_token')
})

await test('Google One identity lookup does not call Code Assist onboarding', async () => {
  const calls: string[] = []
  const account = await fetchGeminiCliIdentity('access', async (url: string) => {
    calls.push(url)
    return Response.json({ email: 'person@example.com' })
  })
  assert.deepEqual(account, { email: 'person@example.com' })
  assert.equal(calls.length, 1)
  assert.match(calls[0], /userinfo/)
})

await test('provider responses hide Gemini CLI credentials and project identifiers', () => {
  const sanitized = new ProviderStore().sanitize(config)
  assert.equal(sanitized.connection.authenticated, true)
  assert.equal('api_key' in sanitized.connection, false)
  assert.equal('refresh_token' in sanitized.connection, false)
  assert.equal('project_id' in sanitized.connection, false)
  assert.equal('account_email' in sanitized.connection, false)
})

console.log('gemini cli adapter')

const googleOneConfig = {
  ...config,
  name: 'gemini-cli-google-one',
  connection: {
    ...config.connection,
    base_url: 'https://generativelanguage.googleapis.com'
  }
}
delete (googleOneConfig.connection as any).project_id

await test('request wrapper uses Code Assist envelope', () => {
  const wrapped = wrapGeminiCliRequest('gemini-2.5-pro', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, 'project')
  assert.equal(wrapped.model, 'gemini-2.5-pro')
  assert.equal(wrapped.project, 'project')
  assert.ok(wrapped.user_prompt_id)
  assert.ok(wrapped.request.session_id)
  assert.equal(wrapped.request.contents[0].parts[0].text, 'hi')
})

await test('Google One sync calls the Gemini API directly without a project envelope', async () => {
  const originalFetch = globalThis.fetch
  let captured: any
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent')
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer google-access')
    captured = JSON.parse(String(init.body))
    return Response.json({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] })
  }) as any
  try {
    const adapter = new GeminiCliAdapter(googleOneConfig)
    const request = adapter.toProviderRequest({
      model: 'gemini-cli-google-one/gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
      config: {},
      stream: false
    })
    const response = await adapter.call(request)
    assert.equal('project' in captured, false)
    assert.equal('request' in captured, false)
    assert.equal(response.candidates[0].content.parts[0].text, 'hello')
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('sync calls unwrap Code Assist responses when a project is configured', async () => {
  const originalFetch = globalThis.fetch
  let captured: any
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.match(url, /v1internal:generateContent$/)
    captured = JSON.parse(String(init.body))
    return Response.json({ response: { candidates: [{ content: { parts: [{ text: 'hello' }] } }] } })
  }) as any
  try {
    const adapter = new GeminiCliAdapter(config)
    const request = adapter.toProviderRequest({
      model: 'gemini-cli/gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
      config: {},
      stream: false
    })
    const response = await adapter.call(request)
    assert.equal(captured.project, 'managed-project')
    assert.equal(captured.model, 'gemini-2.5-pro')
    assert.equal(response.candidates[0].content.parts[0].text, 'hello')
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('Google One stream passes through direct Gemini SSE responses', async () => {
  const originalFetch = globalThis.fetch
  let requestedUrl = ''
  globalThis.fetch = (async (url: string) => {
    requestedUrl = url
    return new Response(
      'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n' +
      'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  }) as any
  try {
    const adapter = new GeminiCliAdapter(googleOneConfig)
    const request = adapter.toProviderRequest({
      model: 'gemini-cli-google-one/gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
      config: {},
      stream: true
    })
    const reader = adapter.callStream(request).getReader()
    let output = ''
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      output += decoder.decode(value, { stream: true })
    }
    assert.equal(requestedUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse')
    assert.match(output, /"text":"hello"/)
    assert.match(output, /"finishReason":"STOP"/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('stream calls unwrap each Code Assist SSE response when a project is configured', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}}\n\n' +
    'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } }
  )) as any
  try {
    const adapter = new GeminiCliAdapter(config)
    const request = adapter.toProviderRequest({
      model: 'gemini-cli/gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
      config: {},
      stream: true
    })
    const reader = adapter.callStream(request).getReader()
    let output = ''
    const decoder = new TextDecoder()
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

console.log(`\n${passed} Gemini CLI subscription test groups passed${process.exitCode ? ', with FAILURES' : ''}`)
