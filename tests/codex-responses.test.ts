import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) {
  console.error('ADAPTER_BUILD not set — run via tests/run-all.sh')
  process.exit(1)
}
const { CodexAdapter } = require(`${buildDir}/providers/codex.js`)
const { ProviderLoader } = require(`${buildDir}/providers/loader.js`)
const { ProviderStore } = require(`${buildDir}/stores/provider.store.js`)
const {
  CODEX_CLIENT_ID,
  CODEX_DEFAULT_CLIENT_VERSION,
  exchangeCodexAuthorizationCode,
  extractChatGptAccountId,
  extractChatGptPlanType,
  extractJwtExpiry,
  pollCodexDeviceCode,
  refreshCodexTokens,
  requestCodexDeviceCode
} = require(`${buildDir}/utils/codex-auth.js`)

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

const tokenPayload = Buffer.from(JSON.stringify({
  exp: 1893456000,
  'https://api.openai.com/auth': {
    chatgpt_account_id: 'acct_from_jwt',
    chatgpt_plan_type: 'plus'
  }
})).toString('base64url')
const accessToken = `header.${tokenPayload}.signature`
const config = {
  name: 'codex-sub',
  protocol: 'codex-subscription',
  connection: {
    base_url: 'https://chatgpt.com/backend-api/codex',
    api_key: accessToken,
    device_id: '11111111-2222-4333-8444-555555555555',
    timeout: 1000,
    enable_timeout: true,
    max_retries: 0,
    client_version: '0.150.0'
  },
  models: [{ id: 'gpt-5.3-codex', display_name: 'GPT-5.3 Codex' }]
}

console.log('codex device login')

await test('device login starts with the fixed OpenAI client and returns the official verification URL', async () => {
  let captured: any
  const device = await requestCodexDeviceCode(async (url: string, init: RequestInit) => {
    captured = { url, body: JSON.parse(String(init.body)) }
    return Response.json({ device_auth_id: 'private-device-auth-id', user_code: 'ABCD-1234', interval: '5' })
  })
  assert.equal(captured.url, 'https://auth.openai.com/api/accounts/deviceauth/usercode')
  assert.equal(captured.body.client_id, CODEX_CLIENT_ID)
  assert.equal(device.user_code, 'ABCD-1234')
  assert.equal(device.verification_url, 'https://auth.openai.com/codex/device')
  assert.equal(device.interval, 5)
})

await test('device login treats 403 and 404 as pending', async () => {
  const pending = await pollCodexDeviceCode('device', 'CODE', async () => new Response('', { status: 404 }))
  assert.deepEqual(pending, { pending: true })
})

await test('authorization code exchange uses the Codex device callback and returns all credentials', async () => {
  let form = new URLSearchParams()
  const tokens = await exchangeCodexAuthorizationCode('auth-code', 'verifier', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://auth.openai.com/oauth/token')
    form = new URLSearchParams(String(init.body))
    return Response.json({ access_token: 'access', refresh_token: 'refresh', id_token: 'id' })
  })
  assert.equal(form.get('grant_type'), 'authorization_code')
  assert.equal(form.get('client_id'), CODEX_CLIENT_ID)
  assert.equal(form.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback')
  assert.deepEqual(tokens, { access_token: 'access', refresh_token: 'refresh', id_token: 'id' })
})

await test('token refresh uses JSON and accepts refresh-token rotation', async () => {
  const refreshed = await refreshCodexTokens('old-refresh', async (_url: string, init: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init.body)), {
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh'
    })
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh' })
  })
  assert.deepEqual(refreshed, { access_token: 'new-access', refresh_token: 'new-refresh' })
})

await test('provider responses expose connection status but never OAuth credentials', () => {
  const sanitized = new ProviderStore().sanitize({
    ...config,
    connection: {
      ...config.connection,
      account_id: 'account-secret',
      refresh_token: 'refresh-secret',
      id_token: 'id-secret'
    }
  })
  assert.equal(sanitized.connection.authenticated, true)
  assert.equal('api_key' in sanitized.connection, false)
  assert.equal('refresh_token' in sanitized.connection, false)
  assert.equal('id_token' in sanitized.connection, false)
  assert.equal('device_id' in sanitized.connection, false)
  assert.equal('account_id' in sanitized.connection, false)
})

await test('model discovery sends the required Codex client version and catalog headers', async () => {
  const originalFetch = globalThis.fetch
  let captured: any
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = { url, headers: init.headers }
    return Response.json({ models: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol' }] })
  }) as any

  try {
    const models = await new ProviderLoader().fetchCodexModels(config)
    assert.equal(captured.url, 'https://chatgpt.com/backend-api/codex/models?client_version=0.150.0')
    assert.equal(captured.headers.Accept, 'application/json')
    assert.equal(captured.headers.originator, 'llmhub')
    assert.equal(captured.headers['x-codex-installation-id'], config.connection.device_id)
    assert.equal(captured.headers['ChatGPT-Account-Id'], 'acct_from_jwt')
    assert.equal(models[0].id, 'codex-sub/gpt-5.6-sol')
    assert.equal(CODEX_DEFAULT_CLIENT_VERSION, '0.149.0')
  } finally {
    globalThis.fetch = originalFetch
  }
})

console.log('codex adapter')

await test('provider request uses Responses shape and injects device_id into client_metadata', () => {
  const adapter = new CodexAdapter(config)
  const payload = adapter.toProviderRequest({
    model: 'codex-sub/gpt-5.3-codex',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '', meta: { toolCalls: [{ id: 'call_1', name: 'shell', input: { cmd: 'pwd' } }] } },
      { role: 'tool', content: '/tmp', meta: { toolCallId: 'call_1', name: 'shell' } }
    ],
    config: { systemPrompt: 'be concise', reasoningEffort: 'high' },
    tools: [{ name: 'shell', description: 'run command', parameters: { type: 'object' } }],
    toolChoice: 'auto',
    stream: false
  })

  assert.equal(payload.model, 'gpt-5.3-codex')
  assert.equal(payload.stream, true)
  assert.equal(payload.store, false)
  assert.equal(payload.client_metadata['x-codex-installation-id'], config.connection.device_id)
  assert.equal(payload.input[0].content[0].type, 'input_text')
  assert.equal(payload.input[1].type, 'function_call')
  assert.equal(payload.input[2].type, 'function_call_output')
  assert.equal(payload.tools[0].name, 'shell')
  assert.equal(payload.tools[0].strict, false)
  assert.deepEqual(payload.reasoning, { effort: 'high', summary: 'auto' })
})

await test('account id is extracted from the Codex access-token JWT', () => {
  assert.equal(extractChatGptAccountId(accessToken), 'acct_from_jwt')
  assert.equal(extractChatGptPlanType(accessToken), 'plus')
  assert.equal(extractJwtExpiry(accessToken), 1893456000000)
  assert.equal(extractChatGptAccountId('opaque-token'), undefined)
})

await test('sync call sends Codex auth headers and collects terminal SSE response', async () => {
  const originalFetch = globalThis.fetch
  let captured: any
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = { url, init, body: JSON.parse(String(init.body)) }
    const completed = {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [{
          type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'hello back' }]
        }],
        usage: { input_tokens: 4, output_tokens: 2 }
      }
    }
    return new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  }) as any

  try {
    const adapter = new CodexAdapter(config)
    const response = await adapter.call({ model: 'gpt-5.3-codex', input: [] })
    assert.equal(captured.url, 'https://chatgpt.com/backend-api/codex/responses')
    assert.equal(captured.init.headers['x-codex-installation-id'], config.connection.device_id)
    assert.equal(captured.init.headers['ChatGPT-Account-Id'], 'acct_from_jwt')
    assert.equal(captured.body.stream, true)
    assert.equal(captured.body.store, false)
    assert.equal(response.id, 'resp_1')
    assert.deepEqual(adapter.fromProviderResponse(response), {
      content: [{ type: 'text', text: 'hello back' }],
      finishReason: 'stop',
      usage: { promptTokens: 4, completionTokens: 2 }
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('quota rejection automatically consumes one banked reset and retries a sync request once', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  let responseAttempts = 0
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    urls.push(url)
    if (url.endsWith('/rate-limit-reset-credits/consume')) {
      const body = JSON.parse(String(init.body))
      assert.equal(typeof body.redeem_request_id, 'string')
      assert.equal('credit_id' in body, false)
      return Response.json({ code: 'reset', windows_reset: 2 })
    }
    responseAttempts++
    if (responseAttempts === 1) return Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 })
    const completed = {
      type: 'response.completed',
      response: { id: 'resp_after_reset', status: 'completed', output: [], usage: {} }
    }
    return new Response(`data: ${JSON.stringify(completed)}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  }) as any

  try {
    const adapter = new CodexAdapter({
      ...config,
      connection: { ...config.connection, auto_reset_on_quota_exhausted: true }
    })
    const response = await adapter.call({ model: 'gpt-5.3-codex', input: [] })
    assert.equal(response.id, 'resp_after_reset')
    assert.equal(responseAttempts, 2)
    assert.equal(urls.filter(url => url.endsWith('/rate-limit-reset-credits/consume')).length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('quota rejection automatically consumes one banked reset and retries a stream request once', async () => {
  const originalFetch = globalThis.fetch
  let responseAttempts = 0
  let consumeAttempts = 0
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith('/rate-limit-reset-credits/consume')) {
      consumeAttempts++
      return Response.json({ code: 'reset', windows_reset: 1 })
    }
    responseAttempts++
    if (responseAttempts === 1) return new Response('quota exhausted', { status: 429 })
    return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  }) as any

  try {
    const adapter = new CodexAdapter({
      ...config,
      connection: { ...config.connection, auto_reset_on_quota_exhausted: true }
    })
    const reader = adapter.callStream({ model: 'gpt-5.3-codex', input: [] }).getReader()
    let output = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      output += new TextDecoder().decode(value)
    }
    assert.match(output, /response\.completed/)
    assert.equal(responseAttempts, 2)
    assert.equal(consumeAttempts, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('stream events normalize text, reasoning, tool calls and usage', () => {
  const adapter = new CodexAdapter(config)
  const state = {}
  assert.deepEqual(adapter.fromProviderStreamChunk({ type: 'response.output_text.delta', delta: 'hi' }, state), {
    type: 'content', delta: 'hi'
  })
  assert.deepEqual(adapter.fromProviderStreamChunk({ type: 'response.reasoning_summary_text.delta', delta: 'think' }, state), {
    type: 'thinking', delta: 'think'
  })
  assert.deepEqual(adapter.fromProviderStreamChunk({
    type: 'response.output_item.added', output_index: 1,
    item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell' }
  }, state), {
    type: 'tool_call', toolCall: { index: 1, id: 'call_1', name: 'shell' }
  })
  assert.deepEqual(adapter.fromProviderStreamChunk({
    type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"cmd":"pwd"}'
  }, state), {
    type: 'tool_call', toolCall: { index: 1, inputDelta: '{"cmd":"pwd"}' }
  })
  assert.deepEqual(adapter.fromProviderStreamChunk({
    type: 'response.completed',
    response: {
      status: 'completed',
      output: [{ type: 'function_call' }],
      usage: { input_tokens: 7, output_tokens: 3 }
    }
  }, state), {
    type: 'done', finishReason: 'tool_calls', usage: { promptTokens: 7, completionTokens: 3 }
  })
})

console.log(`\n${passed} Codex test groups passed${process.exitCode ? ', with FAILURES' : ''}`)
