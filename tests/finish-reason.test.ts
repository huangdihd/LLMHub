import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { OpenAIChatSerializer } from '../server/protocols/openai-chat-serializer.ts'
import { ClaudeMessagesSerializer } from '../server/protocols/claude-messages-serializer.ts'

// Adapters use TS parameter properties (not strip-only compatible),
// so they are precompiled by tests/run-all.sh into $ADAPTER_BUILD.
const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) {
  console.error('ADAPTER_BUILD not set — run via tests/run-all.sh')
  process.exit(1)
}
const { OpenAIAdapter } = require(`${buildDir}/providers/openai.js`)
const { ClaudeAdapter } = require(`${buildDir}/providers/claude.js`)

let passed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ok - ${name}`)
  } catch (e: any) {
    console.error(`  FAIL - ${name}`)
    console.error(e.message)
    process.exitCode = 1
  }
}

const dummyConfig = { name: 'test', connection: {}, models: [] }

console.log('finish_reason propagation — OpenAI adapter')

test('non-stream: length is preserved', () => {
  const adapter = new OpenAIAdapter(dummyConfig)
  const r = adapter.fromProviderResponse({
    choices: [{ message: { content: 'x' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 1, completion_tokens: 2 }
  })
  assert.equal(r.finishReason, 'length')
})

test('non-stream: stop and tool_calls still map correctly', () => {
  const adapter = new OpenAIAdapter(dummyConfig)
  assert.equal(adapter.fromProviderResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }).finishReason, 'stop')
  assert.equal(adapter.fromProviderResponse({
    choices: [{ message: { content: null, tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }]
  }).finishReason, 'tool_calls')
})

test('stream: finish_reason length arrives in the done chunk', () => {
  const adapter = new OpenAIAdapter(dummyConfig)
  const out = adapter.fromProviderStreamChunk({ choices: [{ delta: {}, finish_reason: 'length' }] }, {})
  const chunks = Array.isArray(out) ? out : [out]
  const done = chunks.find((c: any) => c.type === 'done')
  assert.equal(done.finishReason, 'length')
})

console.log('finish_reason propagation — Claude adapter')

test('non-stream: max_tokens maps to length', () => {
  const adapter = new ClaudeAdapter(dummyConfig)
  const r = adapter.fromProviderResponse({
    content: [{ type: 'text', text: 'x' }],
    stop_reason: 'max_tokens',
    usage: { input_tokens: 1, output_tokens: 2 }
  })
  assert.equal(r.finishReason, 'length')
})

test('non-stream: tool_use / end_turn unchanged', () => {
  const adapter = new ClaudeAdapter(dummyConfig)
  assert.equal(adapter.fromProviderResponse({ content: [], stop_reason: 'tool_use' }).finishReason, 'tool_calls')
  assert.equal(adapter.fromProviderResponse({ content: [], stop_reason: 'end_turn' }).finishReason, 'stop')
})

test('stream: message_delta with max_tokens maps to length', () => {
  const adapter = new ClaudeAdapter(dummyConfig)
  const done = adapter.fromProviderStreamChunk({
    type: 'message_delta',
    delta: { stop_reason: 'max_tokens' },
    usage: { output_tokens: 5 }
  }, {})
  assert.equal(done.type, 'done')
  assert.equal(done.finishReason, 'length')
})

console.log('finish_reason propagation — OpenAI chat serializer')

test('non-stream: finish_reason length surfaces to the client', () => {
  const out = new OpenAIChatSerializer().serializeResponse({
    content: 'x',
    finishReason: 'length',
    usage: { promptTokens: 1, completionTokens: 2 }
  })
  assert.equal(out.choices[0].finish_reason, 'length')
})

test('stream: done chunk carries length', () => {
  const out = new OpenAIChatSerializer().serializeStreamChunk({ type: 'done', finishReason: 'length' })
  assert.equal(out.choices[0].finish_reason, 'length')
})

test('stop/tool_calls unchanged', () => {
  const s = new OpenAIChatSerializer()
  assert.equal(s.serializeStreamChunk({ type: 'done', finishReason: 'stop' }).choices[0].finish_reason, 'stop')
  assert.equal(s.serializeStreamChunk({ type: 'done', finishReason: 'tool_calls' }).choices[0].finish_reason, 'tool_calls')
})

console.log('finish_reason propagation — Claude messages serializer')

test('non-stream: length maps to max_tokens', () => {
  const out = new ClaudeMessagesSerializer().serializeResponse({
    content: 'x',
    finishReason: 'length',
    usage: { promptTokens: 1, completionTokens: 2 }
  })
  assert.equal(out.stop_reason, 'max_tokens')
})

test('stream: message_delta carries max_tokens', () => {
  const out = new ClaudeMessagesSerializer().serializeStreamChunk({ type: 'done', finishReason: 'length' })
  assert.equal(out.delta.stop_reason, 'max_tokens')
})

test('stop/tool_calls unchanged', () => {
  const s = new ClaudeMessagesSerializer()
  assert.equal(s.serializeStreamChunk({ type: 'done', finishReason: 'stop' }).delta.stop_reason, 'end_turn')
  assert.equal(s.serializeStreamChunk({ type: 'done', finishReason: 'tool_calls' }).delta.stop_reason, 'tool_use')
})

console.log(`\n${passed} tests passed${process.exitCode ? ', with FAILURES' : ''}`)
