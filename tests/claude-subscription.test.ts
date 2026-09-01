import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) {
  console.error('ADAPTER_BUILD not set — run via tests/run-all.sh')
  process.exit(1)
}

const { ClaudeSubscriptionAdapter } = require(`${buildDir}/providers/claude-subscription.js`)
const { ProviderStore } = require(`${buildDir}/stores/provider.store.js`)
const {
  CLAUDE_CLIENT_ID,
  CLAUDE_CODE_BETA,
  CLAUDE_CODE_SYSTEM_PROMPT,
  CLAUDE_REDIRECT_URI,
  CLAUDE_TOKEN_URL,
  createClaudeAuthorization,
  exchangeClaudeAuthorizationCode,
  parseClaudeAuthorizationCode,
  refreshClaudeTokens
} = require(`${buildDir}/utils/claude-auth.js`)

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
  name: 'claude-sub',
  display_name: 'Claude Subscription',
  protocol: 'claude-subscription',
  enabled: true,
  use_custom_models: false,
  connection: {
    base_url: 'https://api.anthropic.com',
    api_key: 'oauth-access',
    refresh_token: 'oauth-refresh',
    token_expires_at: Date.now() + 60 * 60 * 1000,
    timeout: 1000,
    enable_timeout: true,
    max_retries: 0,
    version: '2023-06-01'
  },
  models: [{ id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' }]
}

console.log('claude subscription oauth')

await test('authorization uses PKCE and the Claude Code client', () => {
  const authorization = createClaudeAuthorization()
  const url = new URL(authorization.authorization_url)
  assert.equal(url.origin, 'https://claude.ai')
  assert.equal(url.pathname, '/oauth/authorize')
  assert.equal(url.searchParams.get('client_id'), CLAUDE_CLIENT_ID)
  assert.equal(url.searchParams.get('redirect_uri'), CLAUDE_REDIRECT_URI)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(url.searchParams.get('code_challenge'))
  assert.ok(authorization.code_verifier)
  assert.ok(authorization.state)
})

await test('copied code may include and validates OAuth state', () => {
  assert.deepEqual(parseClaudeAuthorizationCode('auth-code#expected-state', 'expected-state'), {
    code: 'auth-code', state: 'expected-state'
  })
  assert.throws(
    () => parseClaudeAuthorizationCode('auth-code#other-state', 'expected-state'),
    /state did not match/
  )
})

await test('authorization exchange sends JSON PKCE fields', async () => {
  let captured: any
  const tokens = await exchangeClaudeAuthorizationCode('auth-code', 'verifier', 'state', async (url: string, init: RequestInit) => {
    captured = { url, body: JSON.parse(String(init.body)) }
    return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 7200 })
  })
  assert.equal(captured.url, CLAUDE_TOKEN_URL)
  assert.deepEqual(captured.body, {
    grant_type: 'authorization_code',
    code: 'auth-code',
    state: 'state',
    client_id: CLAUDE_CLIENT_ID,
    code_verifier: 'verifier',
    redirect_uri: CLAUDE_REDIRECT_URI
  })
  assert.deepEqual(tokens, { access_token: 'access', refresh_token: 'refresh', expires_in: 7200 })
})

await test('refresh supports refresh-token rotation', async () => {
  const refreshed = await refreshClaudeTokens('old-refresh', async (_url: string, init: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init.body)), {
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
      client_id: CLAUDE_CLIENT_ID
    })
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })
  })
  assert.deepEqual(refreshed, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })
})

await test('provider responses never expose Claude OAuth credentials', () => {
  const sanitized = new ProviderStore().sanitize(config)
  assert.equal(sanitized.connection.authenticated, true)
  assert.equal('api_key' in sanitized.connection, false)
  assert.equal('refresh_token' in sanitized.connection, false)
})

console.log('claude subscription adapter')

await test('adapter adds required Claude Code prompt and OAuth headers', async () => {
  const originalFetch = globalThis.fetch
  let captured: any
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) }
    return Response.json({
      content: [{ type: 'text', text: 'hello back' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 }
    })
  }) as any

  try {
    const adapter = new ClaudeSubscriptionAdapter(config)
    const request = adapter.toProviderRequest({
      model: 'claude-sub/claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      config: { maxTokens: 100, systemPrompt: 'Be concise.' },
      stream: false
    })
    const response = await adapter.call(request)

    assert.equal(captured.url, 'https://api.anthropic.com/v1/messages')
    assert.equal(captured.headers.Authorization, 'Bearer oauth-access')
    assert.equal(captured.headers['anthropic-beta'], CLAUDE_CODE_BETA)
    assert.equal(captured.headers['x-api-key'], undefined)
    assert.equal(captured.body.system[0].text, CLAUDE_CODE_SYSTEM_PROMPT)
    assert.equal(captured.body.system[1].text, 'Be concise.')
    assert.deepEqual(adapter.fromProviderResponse(response), {
      content: [{ type: 'text', text: 'hello back' }],
      finishReason: 'stop',
      toolCalls: undefined,
      usage: { promptTokens: 5, completionTokens: 2 }
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

console.log(`\n${passed} Claude subscription test groups passed${process.exitCode ? ', with FAILURES' : ''}`)
