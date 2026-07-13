import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { OpenAIResponsesSerializer } from '../server/protocols/openai-responses-serializer.ts'

// Adapters use TS parameter properties (not strip-only compatible),
// so they are precompiled by tests/run-all.sh into $ADAPTER_BUILD.
const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) {
  console.error('ADAPTER_BUILD not set — run via tests/run-all.sh')
  process.exit(1)
}
const { OpenAIAdapter } = require(`${buildDir}/providers/openai.js`)

let passed = 0
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++
      console.log(`  ok - ${name}`)
    })
    .catch((e: any) => {
      console.error(`  FAIL - ${name}`)
      console.error(e.message)
      process.exitCode = 1
    })
}

const dummyConfig = { name: 'test', connection: {}, models: [] }

console.log('tool_call streaming — OpenAI adapter')

await test('delta with both content and tool_calls keeps both', () => {
  const adapter = new OpenAIAdapter(dummyConfig)
  const r = adapter.fromProviderStreamChunk({
    choices: [{
      delta: {
        content: 'calling a tool now',
        tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }]
      }
    }]
  }, {})
  assert(Array.isArray(r), 'expected an array of chunks')
  const content = r.find((c: any) => c.type === 'content')
  assert.equal(content?.delta, 'calling a tool now')
  const tc = r.find((c: any) => c.type === 'tool_call')
  assert.equal(tc?.toolCall?.id, 'c1')
  assert.equal(tc?.toolCall?.name, 'f')
  assert.equal(tc?.toolCall?.inputDelta, '{"a":1}')
})

await test('single tool_call delta keeps index/id/name/arguments', () => {
  const adapter = new OpenAIAdapter(dummyConfig)
  const r: any = adapter.fromProviderStreamChunk({
    choices: [{ delta: { tool_calls: [{ index: 2, id: 'c9', function: { name: 'g', arguments: '{' } }] } }]
  }, {})
  assert.equal(r.type, 'tool_call')
  assert.equal(r.toolCall.index, 2)
  assert.equal(r.toolCall.id, 'c9')
  assert.equal(r.toolCall.name, 'g')
  assert.equal(r.toolCall.inputDelta, '{')
})

await test('parallel tool_calls in one delta all survive', () => {
  const adapter = new OpenAIAdapter(dummyConfig)
  const r: any = adapter.fromProviderStreamChunk({
    choices: [{
      delta: {
        tool_calls: [
          { index: 0, id: 'a', function: { name: 'f1', arguments: '{}' } },
          { index: 1, id: 'b', function: { name: 'f2', arguments: '{}' } }
        ]
      }
    }]
  }, {})
  assert(Array.isArray(r))
  assert.equal(r.length, 2)
  assert.deepEqual(r.map((c: any) => c.toolCall.name), ['f1', 'f2'])
})

console.log('logprobs — OpenAI adapter')

await test('content delta carries upstream logprobs through', () => {
  const adapter = new OpenAIAdapter(dummyConfig)
  const lp = [{ token: 'hi', logprob: -0.4, bytes: [104, 105], top_logprobs: [] }]
  const r: any = adapter.fromProviderStreamChunk({
    choices: [{ delta: { content: 'hi' }, logprobs: { content: lp } }]
  }, {})
  const chunk = Array.isArray(r) ? r.find((c: any) => c.type === 'content') : r
  assert.deepEqual(chunk.logprobs, lp)
})

await test('top_logprobs config becomes logprobs=true + top_logprobs on provider request', () => {
  const adapter = new OpenAIAdapter(dummyConfig)
  const payload = adapter.toProviderRequest({
    model: 'm', messages: [{ role: 'user', content: 'hi' }], config: { topLogprobs: 3 }
  })
  assert.equal(payload.logprobs, true)
  assert.equal(payload.top_logprobs, 3)
})

console.log('tool_call streaming — SSE parsing')

await test('callStream accepts "data:" lines without a space', async () => {
  const originalFetch = globalThis.fetch
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode('data:{"choices":[{"delta":{"content":"hi"}}]}\n\n'))
      c.enqueue(encoder.encode('data: [DONE]\n\n'))
      c.close()
    }
  })
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as any
  try {
    const adapter = new OpenAIAdapter({ name: 'test', connection: { base_url: 'http://mock' }, models: [] })
    const reader = adapter.callStream({}).getReader()
    const decoder = new TextDecoder()
    let out = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      out += decoder.decode(value)
    }
    assert(out.includes('"content":"hi"'), `chunk was dropped, got: ${JSON.stringify(out)}`)
    assert(out.includes('[DONE]'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

console.log('tool_call streaming — Responses serializer')

await test('name-without-id calls split by upstream index, args not merged', () => {
  const s = new OpenAIResponsesSerializer()
  s.serializeStreamChunk({ type: 'tool_call', toolCall: { index: 0, name: 'f1', inputDelta: '{"a":1}' } })
  s.serializeStreamChunk({ type: 'tool_call', toolCall: { index: 1, name: 'f2', inputDelta: '{"b":2}' } })
  const events = s.serializeStreamChunk({ type: 'done', finishReason: 'tool_calls' })
  const completed = events.find((e: any) => e.event === 'response.completed')
  assert(completed, 'no response.completed event')
  const calls = completed!.data.response.output.filter((o: any) => o.type === 'function_call')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].name, 'f1')
  assert.equal(calls[0].arguments, '{"a":1}')
  assert.equal(calls[1].name, 'f2')
  assert.equal(calls[1].arguments, '{"b":2}')
})

await test('id repeated on every delta of the same index stays one call', () => {
  const s = new OpenAIResponsesSerializer()
  s.serializeStreamChunk({ type: 'tool_call', toolCall: { index: 0, id: 'c1', name: 'f', inputDelta: '{"a"' } })
  s.serializeStreamChunk({ type: 'tool_call', toolCall: { index: 0, id: 'c1', inputDelta: ':1}' } })
  const events = s.serializeStreamChunk({ type: 'done', finishReason: 'tool_calls' })
  const completed = events.find((e: any) => e.event === 'response.completed')
  const calls = completed!.data.response.output.filter((o: any) => o.type === 'function_call')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].arguments, '{"a":1}')
})

await test('id-only boundaries still split calls when indices are absent', () => {
  const s = new OpenAIResponsesSerializer()
  s.serializeStreamChunk({ type: 'tool_call', toolCall: { id: 'c1', name: 'f1', inputDelta: '{}' } })
  s.serializeStreamChunk({ type: 'tool_call', toolCall: { id: 'c2', name: 'f2', inputDelta: '{}' } })
  const events = s.serializeStreamChunk({ type: 'done', finishReason: 'tool_calls' })
  const completed = events.find((e: any) => e.event === 'response.completed')
  const calls = completed!.data.response.output.filter((o: any) => o.type === 'function_call')
  assert.equal(calls.length, 2)
})

console.log(`${passed} passed`)
