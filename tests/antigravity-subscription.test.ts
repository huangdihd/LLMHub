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

const { AntigravityAdapter } = require(`${buildDir}/../builtin/provider-antigravity/antigravity.js`)
const { ProviderStore } = require(`${buildDir}/stores/provider.store.js`)
const {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_REDIRECT_URI,
  createAntigravityAuthorization,
  discoverAntigravityAccount,
  exchangeAntigravityAuthorizationCode,
  parseAntigravityAuthorizationCode,
  refreshAntigravityTokens
} = require(`${buildDir}/../builtin/provider-antigravity/antigravity-auth.js`)

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

await test('provider responses hide OAuth identifiers and expose the AI Credits preference', () => {
  const sanitized = new ProviderStore().sanitize({
    ...config,
    connection: { ...config.connection, use_ai_credits_on_quota_exhausted: true }
  })
  assert.equal(sanitized.connection.authenticated, true)
  assert.equal(sanitized.connection.use_ai_credits_on_quota_exhausted, true)
  assert.equal('api_key' in sanitized.connection, false)
  assert.equal('refresh_token' in sanitized.connection, false)
  assert.equal('project_id' in sanitized.connection, false)
  assert.equal('account_email' in sanitized.connection, false)
})

const { ClaudeMessagesParser } = require(`${buildDir}/protocols/claude-messages.js`)
const { ClaudeMessagesSerializer } = require(`${buildDir}/protocols/claude-messages-serializer.js`)

console.log('antigravity adapter')

await test('signed thinking survives response, Claude history and second Antigravity request', () => {
  const adapter = new AntigravityAdapter(config)
  const response = adapter.fromProviderResponse({ candidates: [{ content: { parts: [
    { thought: true, text: 'Thinking', thoughtSignature: 'opaque-signature' },
    { text: 'Hello' }
  ] }, finishReason: 'STOP' }] })
  const message = new ClaudeMessagesSerializer().serializeResponse(response)
  assert.equal(message.content[0].signature, 'opaque-signature')
  const next = new ClaudeMessagesParser().parseRequest({
    model: 'antigravity/claude-opus-4-6-thinking',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: message.content },
      { role: 'user', content: 'again' }
    ]
  })
  const { payload } = adapter.toProviderRequest(next)
  assert.deepEqual(payload.contents[1].parts[0], {
    text: 'Thinking', thought: true, thoughtSignature: 'opaque-signature'
  })
})

await test('non-stream Claude responses preserve text and signature-only parts', async () => {
  const originalFetch = globalThis.fetch
  const parts = [
    { thought: true, text: 'Think' },
    { thought: true, text: 'ing', thoughtSignature: 'first-' },
    { thought: true, thoughtSignature: 'second' },
    { text: 'Hello' }
  ]
  globalThis.fetch = (async () => Response.json({ response: { candidates: [{ content: { parts } }] } })) as any
  try {
    const adapter = new AntigravityAdapter(config)
    const response = await adapter.call({
      modelId: 'claude-opus-4-6-thinking', payload: { contents: [] }
    })
    assert.deepEqual(response.candidates[0].content.parts, parts)
    const converted = adapter.fromProviderResponse(response)
    const thinking = converted.content.filter((block: any) => block.type === 'thinking')
    assert.equal(thinking.map((block: any) => block.thinking).join(''), 'Thinking')
    assert.equal(thinking.map((block: any) => block.signature || '').join(''), 'first-second')
    assert.deepEqual(converted.content.at(-1), { type: 'text', text: 'Hello' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('thinking text and signature-only stream parts emit separate deltas', () => {
  const adapter = new AntigravityAdapter(config)
  const serializer = new ClaudeMessagesSerializer()
  for (const signatureKey of ['thoughtSignature', 'thought_signature']) {
    const chunks = adapter.fromProviderStreamChunk({ candidates: [{ content: { parts: [
      { thought: true, text: 'Thinking', [signatureKey]: 'first-signature' },
      { thought: true, [signatureKey]: 'last-signature' }
    ] } }] })
    assert.deepEqual(chunks, [
      { type: 'thinking', delta: 'Thinking' },
      { type: 'thinking', signature: 'first-signature' },
      { type: 'thinking', signature: 'last-signature' }
    ])
    assert.deepEqual(chunks.map((chunk: any) => serializer.serializeStreamChunk(chunk).delta), [
      { type: 'thinking_delta', thinking: 'Thinking' },
      { type: 'signature_delta', signature: 'first-signature' },
      { type: 'signature_delta', signature: 'last-signature' }
    ])
  }
})

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

await test('language model requests share agent envelopes without model behavior configuration', async () => {
  const originalFetch = globalThis.fetch
  const captured: any[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured.push(JSON.parse(String(init.body)))
    assert.match(url, /v1internal:generateContent$/)
    return Response.json({ response: { candidates: [] } })
  }) as any
  try {
    const adapter = new AntigravityAdapter(config)
    for (const model of ['claude-opus-5-5-high', 'gemini-3-flash', 'custom-image-review-alias']) {
      await adapter.call(adapter.toProviderRequest({
        model: `antigravity/${model}`,
        config: {
          maxTokens: 123,
          outputFormat: { type: 'json_schema', schema: { type: 'object', properties: { scene: { type: 'string' } } } }
        },
        messages: [{ role: 'user', content: 'Describe the scene' }]
      }))
    }
    for (const body of captured) {
      assert.equal(body.requestType, 'agent')
      assert.match(body.requestId, /^agent-/)
      assert.equal(typeof body.request.sessionId, 'string')
      assert.equal(body.request.generationConfig.maxOutputTokens, 123)
      assert.equal(body.request.generationConfig.responseMimeType, 'application/json')
      assert.deepEqual(body.request.generationConfig.responseJsonSchema, {
        type: 'object', properties: { scene: { type: 'string' } }
      })
    }
    const { DEFAULT_ANTIGRAVITY_MODELS } = require(`${buildDir}/../builtin/provider-antigravity/antigravity.js`)
    assert.deepEqual(DEFAULT_ANTIGRAVITY_MODELS.map((model: any) => model.id), [
      'gemini-3-flash', 'gemini-pro-agent', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking'
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('all model names preserve upstream text, signatures, tools and usage on sync requests', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    assert.match(url, /v1internal:generateContent$/)
    return Response.json({ response: {
      candidates: [{ content: { parts: [
        { thought: true, text: 'Thinking', thoughtSignature: 'signature-' },
        { thought: true, thoughtSignature: 'end' },
        { text: 'Hello' },
        { functionCall: { id: 'tool-1', name: 'inspect', args: { scene: 1 } } }
      ] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, cachedContentTokenCount: 2 }
    } })
  }) as any
  try {
    const adapter = new AntigravityAdapter(config)
    for (const model of ['claude-opus-5-5-high', 'gemini-3-flash', 'arbitrary-alias']) {
      const response = adapter.fromProviderResponse(await adapter.call({ modelId: model, payload: { contents: [] } }))
      assert.deepEqual(response.content, [
        { type: 'thinking', thinking: 'Thinking', signature: 'signature-end' },
        { type: 'text', text: 'Hello' }
      ])
      assert.equal(response.toolCalls.length, 1)
      assert.equal(response.toolCalls[0].id, 'tool-1')
      assert.equal(response.toolCalls[0].name, 'inspect')
      assert.deepEqual(response.toolCalls[0].input, { scene: 1 })
      assert.deepEqual(response.usage, { promptTokens: 9, completionTokens: 4, cachedTokens: 2 })
      assert.equal(response.finishReason, 'tool_calls')
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('stream requests use the streaming endpoint for every model name', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    assert.match(url, /v1internal:streamGenerateContent\?\$alt=sse$/)
    return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n')
  }) as any
  try {
    const adapter = new AntigravityAdapter(config)
    for (const model of ['claude-opus-5-5-high', 'gemini-3-flash', 'arbitrary-alias']) {
      const reader = adapter.callStream({ modelId: model, payload: { contents: [] } }).getReader()
      let output = ''
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        output += decoder.decode(value, { stream: true })
      }
      assert.match(output, /"text":"ok"/)
      assert.match(output, /"finishReason":"STOP"/)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('Antigravity preserves visual inputs and images returned by tools', () => {
  const adapter = new AntigravityAdapter(config)
  const inlineImage = { type: 'image', imageBase64: 'AAAA', imageMediaType: 'image/png' }
  const remoteImage = { type: 'image', imageUrl: 'https://example.com/scene.jpg', imageMediaType: 'image/jpeg' }
  const { payload } = adapter.toProviderRequest({
    model: 'antigravity/custom-vlm', config: {}, messages: [
      { role: 'user', content: [{ type: 'text', text: 'Describe' }, inlineImage, remoteImage] },
      { role: 'assistant', content: '', meta: { toolCalls: [{ id: 'image-tool', name: 'inspect', input: {} }] } },
      { role: 'tool', content: [{ type: 'text', text: 'Screenshot' }, inlineImage, remoteImage],
        meta: { toolCallId: 'image-tool', toolName: 'inspect' } }
    ]
  })
  assert.deepEqual(payload.contents[0].parts[1], { inlineData: { data: 'AAAA', mimeType: 'image/png' } })
  assert.deepEqual(payload.contents[0].parts[2], { fileData: { fileUri: remoteImage.imageUrl, mimeType: 'image/jpeg' } })
  assert.deepEqual(payload.contents[2].parts[0].functionResponse.parts, [
    { inlineData: { data: 'AAAA', mimeType: 'image/png' } }
  ])
  assert.deepEqual(payload.contents[2].parts[1], { fileData: { fileUri: remoteImage.imageUrl, mimeType: 'image/jpeg' } })
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

await test('Claude stream sends nullable tool parameters as scalar Google types', async () => {
  const originalFetch = globalThis.fetch
  let captured: any
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body))
    return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n')
  }) as any
  try {
    const adapter = new AntigravityAdapter(config)
    const request = adapter.toProviderRequest({
      model: 'antigravity/claude-opus-4-6-thinking',
      messages: [{ role: 'user', content: 'hi' }],
      config: {},
      tools: [{ name: 'command', parameters: {
        type: 'object', properties: {
          command: { type: 'string' },
          dir: { type: ['string', 'null'] },
          timeout: { type: ['integer', 'null'], minimum: 0 }
        }
      } }],
      stream: true
    })
    const reader = adapter.callStream(request).getReader()
    while (!(await reader.read()).done) { /* Drain the stream to observe the outgoing request. */ }
    const parameters = captured.request.tools[0].functionDeclarations[0].parameters
    assert.deepEqual(parameters.properties.dir, { type: 'string', nullable: true })
    assert.deepEqual(parameters.properties.timeout, { type: 'integer', minimum: 0, nullable: true })
    assert.equal(captured.model, 'claude-opus-4-6-thinking')
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('AI Credits are opt-in and used once after explicit free-quota exhaustion', async () => {
  const originalFetch = globalThis.fetch
  const bodies: any[] = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    if (bodies.length === 1) {
      return Response.json({ error: { status: 'QUOTA_EXHAUSTED', message: 'Quota exhausted' } }, { status: 429 })
    }
    return Response.json({ response: { candidates: [] } })
  }) as any
  try {
    const adapter = new AntigravityAdapter({
      ...config,
      connection: { ...config.connection, use_ai_credits_on_quota_exhausted: true }
    })
    const request = adapter.toProviderRequest({
      model: 'antigravity/gemini-3-flash',
      messages: [{ role: 'user', content: 'hello' }],
      config: {},
      stream: false
    })
    await adapter.call(request)
    assert.equal(bodies.length, 2)
    assert.equal('enabledCreditTypes' in bodies[0], false)
    assert.deepEqual(bodies[1].enabledCreditTypes, ['GOOGLE_ONE_AI'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('ordinary rate limits never enable AI Credits', async () => {
  const originalFetch = globalThis.fetch
  const bodies: any[] = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    if (bodies.length === 1) {
      return Response.json({
        error: { status: 'RESOURCE_EXHAUSTED', message: 'Rate limited', details: [{ reason: 'RATE_LIMIT_EXCEEDED' }] }
      }, { status: 429 })
    }
    return Response.json({ response: { candidates: [] } })
  }) as any
  try {
    const adapter = new AntigravityAdapter({
      ...config,
      connection: { ...config.connection, use_ai_credits_on_quota_exhausted: true }
    })
    const request = adapter.toProviderRequest({
      model: 'antigravity/gemini-3-flash',
      messages: [{ role: 'user', content: 'hello' }],
      config: {},
      stream: false
    })
    await adapter.call(request)
    assert.equal(bodies.length, 2)
    assert.ok(bodies.every(body => !('enabledCreditTypes' in body)))
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('stream requests use AI Credits once after explicit free-quota exhaustion', async () => {
  const originalFetch = globalThis.fetch
  const bodies: any[] = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    if (bodies.length === 1) {
      return Response.json({ error: { status: 'QUOTA_EXHAUSTED', message: 'Quota exhausted' } }, { status: 429 })
    }
    return new Response('data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n\n')
  }) as any
  try {
    const adapter = new AntigravityAdapter({
      ...config,
      connection: { ...config.connection, use_ai_credits_on_quota_exhausted: true }
    })
    const request = adapter.toProviderRequest({
      model: 'antigravity/gemini-3-flash',
      messages: [{ role: 'user', content: 'hello' }],
      config: {},
      stream: true
    })
    const reader = adapter.callStream(request).getReader()
    while (!(await reader.read()).done) { /* Drain the stream. */ }
    assert.equal(bodies.length, 2)
    assert.equal('enabledCreditTypes' in bodies[0], false)
    assert.deepEqual(bodies[1].enabledCreditTypes, ['GOOGLE_ONE_AI'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('disabled AI Credits never alter requests after quota exhaustion', async () => {
  const originalFetch = globalThis.fetch
  const bodies: any[] = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    if (bodies.length === 1) {
      return Response.json({ error: { status: 'QUOTA_EXHAUSTED', message: 'Quota exhausted' } }, { status: 429 })
    }
    return Response.json({ response: { candidates: [] } })
  }) as any
  try {
    const adapter = new AntigravityAdapter(config)
    const request = adapter.toProviderRequest({
      model: 'antigravity/gemini-3-flash',
      messages: [{ role: 'user', content: 'hello' }],
      config: {},
      stream: false
    })
    await adapter.call(request)
    assert.ok(bodies.every(body => !('enabledCreditTypes' in body)))
  } finally {
    globalThis.fetch = originalFetch
  }
})

console.log(`\n${passed} Antigravity subscription test groups passed${process.exitCode ? ', with FAILURES' : ''}`)
