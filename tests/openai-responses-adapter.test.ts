import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('Run via tests/run-all.sh')
const { OpenAIResponsesAdapter } = require(`${build}/providers/openai-responses.js`)
const { OpenAIAdapter } = require(`${build}/providers/openai.js`)
const { ProviderManager } = require(`${build}/providers/manager.js`)
const config = {
  name: 'api', protocol: 'openai',
  connection: { api_type: 'responses', base_url: 'https://offline.invalid/v1/', api_key: 'test-only', enable_timeout: true, timeout: 100, max_retries: 0 },
  models: [{ id: 'gpt-test' }]
}
const adapter = new OpenAIResponsesAdapter(config)
const originalFetch = globalThis.fetch
let passed = 0
async function test(name: string, fn: () => any) {
  try { await fn(); passed++; console.log(`  ok - ${name}`) }
  catch (error) { console.error(`  FAIL - ${name}`, error); process.exitCode = 1 }
  finally { globalThis.fetch = originalFetch }
}
const result = {
  status: 'completed', output: [
    { type: 'reasoning', summary: [{ text: 'Thinking' }], encrypted_content: 'opaque' },
    { type: 'message', content: [{ type: 'output_text', text: 'Hello' }, { type: 'refusal', refusal: 'No' }] },
    { type: 'function_call', id: 'item', call_id: 'call', name: 'search', arguments: '{"q":"a"}' }
  ], usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 5 } }
}

await test('maps complete Responses input, sampling, tools, reasoning and strict schema without Codex policy', () => {
  const payload = adapter.toProviderRequest({
    model: 'api/gpt-test', stream: false,
    config: { systemPrompt: 'Instructions', temperature: 0, topP: 0.7, maxTokens: 99, thinking: { effort: 'none', includeSummary: false }, outputFormat: { type: 'json_schema', name: 'answer', strict: true, schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } } },
    messages: [
      { role: 'system', content: 'System' },
      { role: 'user', content: [{ type: 'text', text: 'Question' }, { type: 'image', imageBase64: 'abc', imageMediaType: 'image/png' }] },
      { role: 'assistant', content: [{ type: 'redacted_thinking', reasoningProvider: 'openai', data: 'opaque' }, { type: 'tool_use', toolUse: { id: 'call', name: 'search', input: { q: 'a' } } }] },
      { role: 'tool', content: 'found', meta: { toolCallId: 'call' } }
    ], tools: [{ name: 'search', description: 'Search', parameters: { type: 'object' } }], toolChoice: { name: 'search' }
  })
  assert.equal(payload.model, 'gpt-test')
  assert.equal(payload.stream, false)
  assert.equal(payload.temperature, 0)
  assert.equal(payload.top_p, 0.7)
  assert.equal(payload.max_output_tokens, 99)
  assert.equal(payload.instructions, 'Instructions')
  assert.equal(payload.input[0].role, 'system')
  assert.equal(payload.input[1].content[1].image_url, 'data:image/png;base64,abc')
  assert.equal(payload.input[2].encrypted_content, 'opaque')
  assert.equal(payload.input[3].call_id, 'call')
  assert.deepEqual(payload.input[4], { type: 'function_call_output', call_id: 'call', output: 'found' })
  assert.deepEqual(payload.reasoning, { effort: 'none' })
  assert.equal(payload.text.format.strict, true)
  assert.equal(payload.tools[0].name, 'search')
  assert.deepEqual(payload.tool_choice, { type: 'function', name: 'search' })
  assert.equal('store' in payload, false)
  assert.equal('client_metadata' in payload, false)
})

await test('sync sends API-key JSON request and normalizes output, usage, tools and opaque reasoning', async () => {
  globalThis.fetch = async (url: any, init: any) => {
    assert.equal(url, 'https://offline.invalid/v1/responses')
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer test-only' })
    assert.deepEqual(JSON.parse(init.body), { model: 'gpt-test', stream: false })
    return Response.json(result)
  }
  const normalized = adapter.fromProviderResponse(await adapter.call({ model: 'gpt-test', stream: true }))
  assert.equal(normalized.finishReason, 'tool_calls')
  assert.deepEqual(normalized.usage, { promptTokens: 12, completionTokens: 4, cachedTokens: 5 })
  assert.deepEqual(normalized.toolCalls, [{ id: 'call', name: 'search', input: { q: 'a' } }])
  assert.equal(normalized.content[1].reasoningProvider, 'openai')
  assert.equal(normalized.content[1].data, 'opaque')
  assert.equal(normalized.content[2].text, 'Hello')
  assert.equal(adapter.fromProviderResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }).finishReason, 'length')
})

await test('stream framing tolerates split UTF-8/CRLF and normalizes tools, reasoning, refusal and terminal usage', async () => {
  const events = [
    { type: 'response.reasoning_summary_text.delta', delta: 'Think' },
    { type: 'response.output_text.delta', delta: '你好' },
    { type: 'response.refusal.delta', delta: 'No' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'item', call_id: 'call', name: 'search' } },
    { type: 'response.function_call_arguments.delta', item_id: 'item', delta: '{"q":"a"}' },
    { type: 'response.output_item.done', output_index: 1, item: result.output[2] },
    { type: 'response.output_item.done', item: result.output[0] },
    { type: 'response.completed', response: result }
  ]
  const bytes = new TextEncoder().encode(events.map(e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(''))
  globalThis.fetch = async (_url: any, init: any) => {
    assert.equal(init.headers.Accept, 'text/event-stream')
    assert.equal(JSON.parse(init.body).stream, true)
    return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close() } }))
  }
  const wire = await new Response(await adapter.callStream({})).text()
  const state = {}
  const chunks = wire.trim().split('\n\n').map(line => adapter.fromProviderStreamChunk(JSON.parse(line.slice(6)), state))
  assert.equal(chunks[0].type, 'thinking')
  assert.equal(chunks[1].delta, '你好')
  assert.equal(chunks[2].delta, 'No')
  assert.equal(chunks[3].toolCall.id, 'call')
  assert.equal(chunks[4].toolCall.inputDelta, '{"q":"a"}')
  assert.equal(chunks[5].delta, '')
  assert.equal(chunks[6].encryptedContent, 'opaque')
  assert.deepEqual(chunks[7], { type: 'done', finishReason: 'tool_calls', usage: { promptTokens: 12, completionTokens: 4, cachedTokens: 5 } })
})

await test('HTTP and SSE failures propagate; truncated streams do not succeed', async () => {
  globalThis.fetch = async () => Response.json({ error: { message: 'Bad key' } }, { status: 401 })
  await assert.rejects(adapter.call({}), (e: any) => e._statusCode === 401 && e._source === 'api')
  globalThis.fetch = async () => new Response('data: {"type":"response.failed","response":{"error":{"message":"Failed"}}}\n\n')
  await assert.rejects(new Response(await adapter.callStream({})).text(), /Failed/)
  globalThis.fetch = async () => new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n')
  await assert.rejects(new Response(await adapter.callStream({})).text(), /terminal response/)
})

await test('timeout remains active during response body reads and cancellation aborts upstream', async () => {
  const fast = new OpenAIResponsesAdapter({ ...config, connection: { ...config.connection, timeout: 5 } })
  let signal: AbortSignal
  globalThis.fetch = async (_url: any, init: any) => {
    signal = init.signal
    return new Response(new ReadableStream({ start(c) { signal.addEventListener('abort', () => c.error(new Error('aborted'))) } }))
  }
  await assert.rejects(new Response(await fast.callStream({})).text(), /aborted|timeout/)
  await assert.rejects(fast.call({}), /timeout/)
  const stream = await adapter.callStream({})
  await stream.cancel()
  assert.equal(signal!.aborted, true)
})

await test('stream timeout resets per read rather than limiting total duration', async () => {
  const timed = new OpenAIResponsesAdapter({ ...config, connection: { ...config.connection, timeout: 100 } })
  const encoder = new TextEncoder()
  let index = 0
  globalThis.fetch = async () => new Response(new ReadableStream({
    async pull(controller) {
      await new Promise(resolve => setTimeout(resolve, 30))
      if (index++ < 5) controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"x"}\n\n'))
      else {
        controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n'))
        controller.close()
      }
    }
  }))
  const wire = await new Response(await timed.callStream({})).text()
  assert.match(wire, /response.completed/)
  assert.equal(index, 6)
})

await test('embeddings stay on the standard endpoint', async () => {
  globalThis.fetch = async (url: any, init: any) => {
    assert.match(url, /\/embeddings$/)
    assert.equal(init.headers.Authorization, 'Bearer test-only')
    return Response.json({ model: 'embed', data: [{ index: 0, embedding: [1, 2] }], usage: { prompt_tokens: 2, total_tokens: 2 } })
  }
  const response = await adapter.embed({ model: 'api/embed', input: 'text' })
  assert.ok(response)
})

await test('manager selects Responses only for explicit opt-in and retains legacy chat default', async () => {
  const manager = new ProviderManager()
  manager.loader = {
    loadAll: async () => {},
    getAllProviders: () => [config, { ...config, name: 'legacy', connection: { ...config.connection, api_type: undefined } }, { ...config, name: 'chat', connection: { ...config.connection, api_type: 'chat_completions' } }]
  }
  await manager.loadProviders()
  assert.ok(manager.getAdapter('api') instanceof OpenAIResponsesAdapter)
  assert.ok(manager.getAdapter('legacy') instanceof OpenAIAdapter)
  assert.ok(manager.getAdapter('chat') instanceof OpenAIAdapter)
})
console.log(`OpenAI Responses adapter: ${passed} tests passed`)
