// End-to-end tests: real SDKs → LLMHub gateway → mock upstream (recorded fixtures).
// Expected values are derived from the recordings themselves, so re-recording
// upstream behavior does not require editing assertions here.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

const GATEWAY = process.env.GATEWAY_URL || 'http://127.0.0.1:3999'
const API_KEY = 'llmhub-e2e-test-key'
const REC_DIR = path.resolve(import.meta.dirname, 'recordings')

const openai = new OpenAI({ baseURL: `${GATEWAY}/api/openai`, apiKey: API_KEY })
const anthropic = new Anthropic({ baseURL: `${GATEWAY}/api/claude`, apiKey: API_KEY })

// ---- expected values assembled from recordings ------------------------------
const rec = (protocol, scenario, kind) =>
  JSON.parse(fs.readFileSync(path.join(REC_DIR, protocol, `${scenario}-${kind}.json`), 'utf8'))

const expected = {
  openaiSyncText: rec('openai', 'text', 'sync').body.choices[0].message.content,
  openaiStreamText: rec('openai', 'text', 'stream').events.map(e => e.choices?.[0]?.delta?.content || '').join(''),
  claudeSyncText: rec('claude', 'text', 'sync').body.content.filter(b => b.type === 'text').map(b => b.text).join(''),
  claudeStreamText: rec('claude', 'text', 'stream').events
    .filter(e => e.type === 'content_block_delta' && e.delta?.type === 'text_delta')
    .map(e => e.delta.text).join(''),
  geminiSyncText: (rec('gemini', 'text', 'sync').body.candidates[0].content.parts || [])
    .filter(p => p.text && !p.thought).map(p => p.text).join(''),
  geminiStreamText: rec('gemini', 'text', 'stream').events
    .flatMap(e => e.candidates?.[0]?.content?.parts || [])
    .filter(p => p.text && !p.thought).map(p => p.text).join(''),
  openaiToolArgs: JSON.parse(rec('openai', 'tool-call', 'sync').body.choices[0].message.tool_calls[0].function.arguments)
}

// ---- tiny runner -------------------------------------------------------------
let passed = 0, failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok - ${name}`)
  } catch (e) {
    failed++
    console.error(`  FAIL - ${name}`)
    console.error(`    ${(e.stack || e.message).split('\n').slice(0, 4).join('\n    ')}`)
  }
}

// =============================================================================
console.log('Responses API ingress (openai SDK)')

await test('non-stream × openai upstream', async () => {
  const r = await openai.responses.create({ model: '_e2e-openai/text', input: 'hi' })
  assert.equal(r.object, 'response')
  assert.equal(r.status, 'completed')
  assert.equal(r.output_text, expected.openaiSyncText)
  assert.ok(r.usage.input_tokens > 0)
})

await test('non-stream × claude upstream', async () => {
  const r = await openai.responses.create({ model: '_e2e-claude/text', input: 'hi' })
  assert.equal(r.status, 'completed')
  assert.equal(r.output_text, expected.claudeSyncText)
})

await test('non-stream × gemini upstream', async () => {
  const r = await openai.responses.create({ model: '_e2e-gemini/text', input: 'hi' })
  assert.equal(r.status, 'completed')
  assert.equal(r.output_text, expected.geminiSyncText)
})

await test('stream: event sequence + assembled text', async () => {
  const stream = await openai.responses.create({ model: '_e2e-openai/text', input: 'hi', stream: true })
  const types = []
  let deltaText = ''
  let completedResponse = null
  for await (const ev of stream) {
    types.push(ev.type)
    if (ev.type === 'response.output_text.delta') deltaText += ev.delta
    if (ev.type === 'response.completed') completedResponse = ev.response
  }
  assert.equal(types[0], 'response.created')
  assert.ok(types.includes('response.output_item.added'))
  assert.equal(types[types.length - 1], 'response.completed')
  assert.equal(deltaText, expected.openaiStreamText)
  const msg = completedResponse.output.find(i => i.type === 'message')
  assert.equal(msg.content[0].text, expected.openaiStreamText)
  assert.ok(completedResponse.usage.input_tokens > 0, 'usage should be captured from the stream')
})

await test('stream: tool call via function_call events', async () => {
  const stream = await openai.responses.create({
    model: '_e2e-openai/tool-call', input: 'weather?', stream: true,
    tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }]
  })
  let args = ''
  let fcItem = null
  for await (const ev of stream) {
    if (ev.type === 'response.function_call_arguments.delta') args += ev.delta
    if (ev.type === 'response.output_item.done' && ev.item.type === 'function_call') fcItem = ev.item
  }
  assert.equal(fcItem.name, 'get_weather')
  assert.deepEqual(JSON.parse(args), expected.openaiToolArgs)
  assert.deepEqual(JSON.parse(fcItem.arguments), expected.openaiToolArgs)
})

await test('stream × claude upstream: thinking block + tool call', async () => {
  // The recording shows mimo streams a thinking block, then tool_use —
  // through the Responses egress that must become reasoning + function_call.
  const stream = await openai.responses.create({ model: '_e2e-claude/tool-call', input: 'weather?', stream: true })
  let completed = null
  for await (const ev of stream) {
    if (ev.type === 'response.completed') completed = ev.response
  }
  const kinds = completed.output.map(i => i.type)
  assert.ok(kinds.includes('reasoning'), `expected a reasoning item, got ${kinds}`)
  assert.ok(kinds.includes('function_call'), `expected a function_call item, got ${kinds}`)
  const fc = completed.output.find(i => i.type === 'function_call')
  assert.equal(fc.name, 'get_weather')
  assert.ok(JSON.parse(fc.arguments).city)
})

await test('truncation surfaces as incomplete', async () => {
  const r = await openai.responses.create({ model: '_e2e-openai/truncated', input: 'count' })
  assert.equal(r.status, 'incomplete')
  assert.equal(r.incomplete_details.reason, 'max_output_tokens')
})

await test('upstream closes without [DONE]: response still completes', async () => {
  const stream = await openai.responses.create({ model: '_e2e-openai/no-done', input: 'hi', stream: true })
  let completed = null
  for await (const ev of stream) {
    if (ev.type === 'response.completed') completed = ev.response
  }
  assert.ok(completed, 'response.completed must be emitted even without upstream [DONE]')
  assert.equal(completed.output.find(i => i.type === 'message').content[0].text, expected.openaiStreamText)
})

await test('reasoning stream produces a reasoning item', async () => {
  const stream = await openai.responses.create({ model: '_e2e-openai/reasoning', input: '17+25?', stream: true })
  let completed = null
  let sawReasoningDelta = false
  for await (const ev of stream) {
    if (ev.type === 'response.reasoning_summary_text.delta') sawReasoningDelta = true
    if (ev.type === 'response.completed') completed = ev.response
  }
  assert.ok(sawReasoningDelta)
  assert.equal(completed.output[0].type, 'reasoning')
})

// =============================================================================
console.log('Chat Completions ingress (openai SDK)')

await test('non-stream text', async () => {
  const r = await openai.chat.completions.create({
    model: '_e2e-openai/text', messages: [{ role: 'user', content: 'hi' }]
  })
  assert.equal(r.choices[0].message.content, expected.openaiSyncText)
  assert.equal(r.choices[0].finish_reason, 'stop')
})

await test('stream: single id across chunks, finish_reason length on truncation', async () => {
  const stream = await openai.chat.completions.create({
    model: '_e2e-openai/truncated', messages: [{ role: 'user', content: 'count' }], stream: true
  })
  const ids = new Set()
  let finish = null
  for await (const chunk of stream) {
    ids.add(chunk.id)
    if (chunk.choices[0]?.finish_reason) finish = chunk.choices[0].finish_reason
  }
  assert.equal(ids.size, 1)
  assert.equal(finish, 'length')
})

await test('stream: tool call fragments reassemble', async () => {
  const stream = await openai.chat.completions.create({
    model: '_e2e-openai/tool-call', messages: [{ role: 'user', content: 'weather?' }], stream: true,
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }]
  })
  let name = null, args = ''
  for await (const chunk of stream) {
    const tc = chunk.choices[0]?.delta?.tool_calls?.[0]
    if (tc?.function?.name) name = tc.function.name
    if (tc?.function?.arguments) args += tc.function.arguments
  }
  assert.equal(name, 'get_weather')
  assert.deepEqual(JSON.parse(args), expected.openaiToolArgs)
})

// =============================================================================
console.log('Legacy Completions ingress (openai SDK)')

await test('returns text_completion with choices[].text', async () => {
  const r = await openai.completions.create({ model: '_e2e-openai/text', prompt: 'hi', max_tokens: 50 })
  assert.equal(r.object, 'text_completion')
  assert.equal(r.choices[0].text, expected.openaiSyncText)
})

// =============================================================================
console.log('Claude Messages ingress (anthropic SDK)')

await test('non-stream × claude upstream', async () => {
  const r = await anthropic.messages.create({
    model: '_e2e-claude/text', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }]
  })
  assert.equal(r.content.filter(b => b.type === 'text').map(b => b.text).join(''), expected.claudeSyncText)
  assert.equal(r.stop_reason, 'end_turn')
})

await test('non-stream × openai upstream (cross-protocol)', async () => {
  const r = await anthropic.messages.create({
    model: '_e2e-openai/text', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }]
  })
  assert.equal(r.content.filter(b => b.type === 'text').map(b => b.text).join(''), expected.openaiSyncText)
})

await test('SDK stream helper assembles the final message', async () => {
  const stream = anthropic.messages.stream({
    model: '_e2e-claude/text', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }]
  })
  const final = await stream.finalMessage()
  assert.equal(final.content.filter(b => b.type === 'text').map(b => b.text).join(''), expected.claudeStreamText)
})

await test('truncation → stop_reason max_tokens', async () => {
  const r = await anthropic.messages.create({
    model: '_e2e-claude/truncated', max_tokens: 8, messages: [{ role: 'user', content: 'count' }]
  })
  assert.equal(r.stop_reason, 'max_tokens')
})

await test('tool call → tool_use block', async () => {
  const r = await anthropic.messages.create({
    model: '_e2e-claude/tool-call', max_tokens: 300,
    messages: [{ role: 'user', content: 'weather?' }],
    tools: [{ name: 'get_weather', description: 'weather', input_schema: { type: 'object' } }]
  })
  const tu = r.content.find(b => b.type === 'tool_use')
  assert.equal(tu.name, 'get_weather')
  assert.ok(tu.input.city)
  assert.equal(r.stop_reason, 'tool_use')
})

// =============================================================================
console.log('Claude legacy /v1/complete ingress (anthropic SDK)')

await test('returns type completion', async () => {
  const r = await anthropic.completions.create({
    model: '_e2e-claude/text', prompt: '\n\nHuman: hi\n\nAssistant:', max_tokens_to_sample: 64
  })
  assert.equal(r.type, 'completion')
  assert.equal(r.completion, expected.claudeSyncText)
  assert.ok(['stop_sequence', 'max_tokens'].includes(r.stop_reason))
})

// =============================================================================
console.log('Gemini ingress (raw HTTP, official wire format)')

const gfetch = (p, body) => fetch(`${GATEWAY}/api/gemini/v1beta/${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
  body: JSON.stringify(body)
})
const GEM_BODY = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }

await test('generateContent', async () => {
  const r = await gfetch('models/_e2e-gemini/text:generateContent', GEM_BODY)
  assert.equal(r.status, 200)
  const d = await r.json()
  const text = d.candidates[0].content.parts.filter(p => p.text && !p.thought).map(p => p.text).join('')
  assert.equal(text, expected.geminiSyncText)
  assert.equal(d.candidates[0].finishReason, 'STOP')
})

await test('streamGenerateContent?alt=sse streams SSE frames', async () => {
  const r = await gfetch('models/_e2e-gemini/text:streamGenerateContent?alt=sse', GEM_BODY)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type') || '', /text\/event-stream/)
  const raw = await r.text()
  const events = raw.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)))
  const text = events.flatMap(e => e.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('')
  assert.equal(text, expected.geminiStreamText)
})

await test('streamGenerateContent without alt=sse returns a JSON array', async () => {
  const r = await gfetch('models/_e2e-gemini/text:streamGenerateContent', GEM_BODY)
  assert.equal(r.status, 200)
  const d = await r.json()
  assert.ok(Array.isArray(d), 'expected a JSON array of chunks')
  const text = d.flatMap(e => e.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('')
  assert.equal(text, expected.geminiStreamText)
})

// =============================================================================
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
