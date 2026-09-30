import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) throw new Error('ADAPTER_BUILD not set — run via tests/run-all.sh')
const { OpenAIAdapter } = require(`${buildDir}/providers/openai.js`)
const { CodexAdapter } = require(`${buildDir}/providers/codex.js`)
const { ClaudeAdapter } = require(`${buildDir}/providers/claude.js`)
const { ClaudeSubscriptionAdapter } = require(`${buildDir}/providers/claude-subscription.js`)
const { GeminiAdapter } = require(`${buildDir}/providers/gemini.js`)
const { AntigravityAdapter } = require(`${buildDir}/providers/antigravity.js`)

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ok - ${name}`)
  } catch (error) {
    console.error(`  FAIL - ${name}`, error)
    process.exitCode = 1
  }
}

const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false
}
const format = { type: 'json_schema', name: 'answer', description: 'An answer', schema }
const cases = [
  { Adapter: OpenAIAdapter, protocol: 'openai', model: 'gpt-test', kind: 'chat' },
  { Adapter: CodexAdapter, protocol: 'codex', model: 'gpt-test', kind: 'responses' },
  { Adapter: ClaudeAdapter, protocol: 'claude', model: 'claude-test', kind: 'claude' },
  { Adapter: ClaudeSubscriptionAdapter, protocol: 'claude-subscription', model: 'claude-test', kind: 'claude' },
  { Adapter: GeminiAdapter, protocol: 'gemini', model: 'gemini-test', kind: 'gemini' },
  { Adapter: AntigravityAdapter, protocol: 'antigravity-subscription', model: 'gemini-3-flash', kind: 'gemini' }
]

function adapterFor(entry: typeof cases[number]) {
  return new entry.Adapter({
    name: 'test', protocol: entry.protocol, enabled: true,
    connection: {
      base_url: 'https://example.invalid', api_key: 'test-token',
      token_expires_at: Date.now() + 3600000, project_id: 'test-project',
      device_id: 'test-device', enable_timeout: false, max_retries: 0
    },
    models: [{ id: entry.model }]
  })
}

function requestFor(entry: typeof cases[number], outputFormat: any = format, stream = false) {
  return {
    model: `test/${entry.model}`, messages: [{ role: 'user', content: 'Return JSON' }], stream,
    config: {
      outputFormat, maxTokens: 100, temperature: 0.2,
      thinking: { enabled: true, mode: 'adaptive', effort: 'high', budgetTokens: 64 }
    }
  }
}

function assertFormat(entry: typeof cases[number], body: any) {
  if (entry.kind === 'chat') {
    assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'answer', description: 'An answer', schema } })
    assert.equal(body.reasoning_effort, 'high')
  } else if (entry.kind === 'responses') {
    assert.deepEqual(body.text.format, format)
    assert.equal(body.reasoning.effort, 'high')
  } else if (entry.kind === 'claude') {
    assert.deepEqual(body.output_config.format, { type: 'json_schema', schema })
    assert.equal(body.output_config.effort, 'high')
  } else {
    assert.equal(body.generationConfig.responseMimeType, 'application/json')
    assert.deepEqual(body.generationConfig.responseJsonSchema, schema)
    assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 64)
  }
}

console.log('provider structured output')
for (const entry of cases) {
  await test(`${entry.protocol} maps schema without losing thinking`, () => {
    const request = requestFor(entry)
    const before = JSON.stringify(request)
    const mapped = adapterFor(entry).toProviderRequest(request)
    assertFormat(entry, mapped.payload || mapped)
    assert.equal(JSON.stringify(request), before)
  })

  await test(`${entry.protocol} maps explicit text and JSON mode`, () => {
    const adapter = adapterFor(entry)
    const text = adapter.toProviderRequest(requestFor(entry, { type: 'text' }))
    const body = text.payload || text
    if (entry.kind === 'chat') assert.deepEqual(body.response_format, { type: 'text' })
    if (entry.kind === 'responses') assert.deepEqual(body.text.format, { type: 'text' })
    if (entry.kind === 'claude') assert.equal(body.output_config.format, undefined)
    if (entry.kind === 'gemini') assert.equal(body.generationConfig.responseMimeType, 'text/plain')
    if (entry.kind === 'claude') return
    const json = adapter.toProviderRequest(requestFor(entry, { type: 'json_object' }))
    const jsonBody = json.payload || json
    if (entry.kind === 'chat') assert.deepEqual(jsonBody.response_format, { type: 'json_object' })
    if (entry.kind === 'responses') assert.deepEqual(jsonBody.text.format, { type: 'json_object' })
    if (entry.kind === 'gemini') {
      assert.equal(jsonBody.generationConfig.responseMimeType, 'application/json')
      assert.equal(jsonBody.generationConfig.responseJsonSchema, undefined)
      assert.equal(jsonBody.generationConfig.responseSchema, undefined)
    }
  })

  await test(`${entry.protocol} absent format leaves defaults untouched`, () => {
    const request = requestFor(entry)
    delete request.config.outputFormat
    const mapped = adapterFor(entry).toProviderRequest(request)
    const body = mapped.payload || mapped
    assert.equal(body.response_format, undefined)
    assert.equal(body.text, undefined)
    assert.equal(body.output_config?.format, undefined)
    assert.equal(body.generationConfig?.responseMimeType, undefined)
  })

  await test(`${entry.protocol} rejects incompatible contracts before fetch`, () => {
    const adapter = adapterFor(entry)
    const incompatible = entry.kind === 'gemini' || entry.kind === 'claude'
      ? { ...format, strict: true }
      : { ...format, schemaDialect: 'gemini' }
    assert.throws(() => adapter.toProviderRequest(requestFor(entry, incompatible)), (error: any) => error.statusCode === 400)
    if (entry.kind === 'claude') {
      assert.throws(() => adapter.toProviderRequest(requestFor(entry, { type: 'json_object' })), (error: any) => error.statusCode === 400)
    }
  })

  for (const stream of [false, true]) {
    await test(`${entry.protocol} sends schema on ${stream ? 'stream' : 'sync'} transport`, async () => {
      const originalFetch = globalThis.fetch
      const bodies: any[] = []
      globalThis.fetch = async (_url: any, init: any) => {
        bodies.push(JSON.parse(init.body))
        if (!stream) {
          return Response.json(entry.protocol === 'antigravity-subscription' ? { response: { candidates: [] } } : { choices: [], content: [], candidates: [], output: [] })
        }
        let event: any = {}
        if (entry.kind === 'responses') {
          event = { type: 'response.completed', response: { id: 'resp-test', status: 'completed', output: [] } }
        } else if (entry.protocol === 'antigravity-subscription') {
          event = { response: { candidates: [] } }
        } else if (entry.kind === 'claude') {
          event = { type: 'message_stop' }
        }
        return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      }
      try {
        const adapter = adapterFor(entry)
        const mapped = adapter.toProviderRequest(requestFor(entry, format, stream))
        if (stream) {
          const reader = (await adapter.callStream(mapped)).getReader()
          while (!(await reader.read()).done) { /* Drain the mocked stream. */ }
        } else {
          await adapter.call(mapped)
        }
        assert.equal(bodies.length, 1)
        assertFormat(entry, entry.protocol === 'antigravity-subscription' ? bodies[0].request : bodies[0])
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  }
}

await test('Gemini dialect uses responseSchema without rewriting the schema', () => {
  for (const entry of cases.filter(entry => entry.kind === 'gemini')) {
    const geminiSchema = { type: 'OBJECT', properties: { answer: { type: 'STRING' } }, propertyOrdering: ['answer'] }
    const mapped = adapterFor(entry).toProviderRequest(requestFor(entry, { ...format, schema: geminiSchema, schemaDialect: 'gemini' }))
    assert.deepEqual(mapped.payload.generationConfig.responseSchema, geminiSchema)
    assert.equal(mapped.payload.generationConfig.responseJsonSchema, undefined)
  }
})

await test('Antigravity Claude explicitly rejects structured output', () => {
  const entry = { ...cases[5], model: 'claude-sonnet-4-6' }
  const adapter = adapterFor(entry)
  for (const outputFormat of [format, { type: 'json_object' }]) {
    assert.throws(() => adapter.toProviderRequest(requestFor(entry, outputFormat)), (error: any) => error.statusCode === 400)
  }
  assert.doesNotThrow(() => adapter.toProviderRequest(requestFor(entry, { type: 'text' })))
})
