// End-to-end tests: real official SDKs → LLMHub gateway → mock upstream (recorded fixtures).
// - openai SDK        → /api/openai   (Responses, Chat Completions, legacy Completions, Embeddings)
// - @anthropic-ai/sdk → /api/claude   (Messages, legacy Text Completions)
// - @google/genai     → /api/gemini   (generateContent, streamGenerateContent)
// Expected values are derived from the recordings, so re-recording upstream
// behavior does not require editing assertions here.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI } from '@google/genai'

const GATEWAY = process.env.GATEWAY_URL || 'http://127.0.0.1:3999'
const API_KEY = 'llmhub-e2e-test-key'
const REC_DIR = path.resolve(import.meta.dirname, 'recordings')

const openai = new OpenAI({ baseURL: `${GATEWAY}/api/openai`, apiKey: API_KEY })
const anthropic = new Anthropic({ baseURL: `${GATEWAY}/api/claude`, apiKey: API_KEY })
const gemini = new GoogleGenAI({ apiKey: API_KEY, httpOptions: { baseUrl: `${GATEWAY}/api/gemini` } })

const UP = { openai: '_e2e-openai', claude: '_e2e-claude', gemini: '_e2e-gemini' }
const UPSTREAMS = ['openai', 'claude', 'gemini']

// ---- expected values assembled from recordings ------------------------------
const rec = (protocol, scenario, kind) =>
  JSON.parse(fs.readFileSync(path.join(REC_DIR, protocol, `${scenario}-${kind}.json`), 'utf8'))

const textOf = {
  openai: {
    sync: r => r.body.choices[0].message.content,
    stream: r => r.events.map(e => e.choices?.[0]?.delta?.content || '').join('')
  },
  claude: {
    sync: r => r.body.content.filter(b => b.type === 'text').map(b => b.text).join(''),
    stream: r => r.events
      .filter(e => e.type === 'content_block_delta' && e.delta?.type === 'text_delta')
      .map(e => e.delta.text).join('')
  },
  gemini: {
    sync: r => (r.body.candidates[0].content.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join(''),
    stream: r => r.events
      .flatMap(e => e.candidates?.[0]?.content?.parts || [])
      .filter(p => p.text && !p.thought).map(p => p.text).join('')
  }
}

const expText = {}, expToolResult = {}
for (const p of UPSTREAMS) {
  expText[p] = { sync: textOf[p].sync(rec(p, 'text', 'sync')), stream: textOf[p].stream(rec(p, 'text', 'stream')) }
  expToolResult[p] = { sync: textOf[p].sync(rec(p, 'tool-result', 'sync')) }
}
const expToolArgs = JSON.parse(rec('openai', 'tool-call', 'sync').body.choices[0].message.tool_calls[0].function.arguments)

const geminiText = (r) => (r.candidates?.[0]?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('')

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
console.log('Text matrix: every ingress × every upstream protocol (non-stream)')

for (const up of UPSTREAMS) {
  await test(`responses ingress × ${up} upstream`, async () => {
    const r = await openai.responses.create({ model: `${UP[up]}/text`, input: 'hi' })
    assert.equal(r.object, 'response')
    assert.equal(r.status, 'completed')
    assert.equal(r.output_text, expText[up].sync)
    assert.ok(r.usage.input_tokens > 0)
  })
}

for (const up of UPSTREAMS) {
  await test(`chat ingress × ${up} upstream`, async () => {
    const r = await openai.chat.completions.create({ model: `${UP[up]}/text`, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(r.choices[0].message.content, expText[up].sync)
    assert.equal(r.choices[0].finish_reason, 'stop')
  })
}

for (const up of UPSTREAMS) {
  await test(`messages ingress × ${up} upstream`, async () => {
    const r = await anthropic.messages.create({
      model: `${UP[up]}/text`, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }]
    })
    assert.equal(r.content.filter(b => b.type === 'text').map(b => b.text).join(''), expText[up].sync)
    assert.equal(r.stop_reason, 'end_turn')
  })
}

for (const up of UPSTREAMS) {
  await test(`gemini ingress (@google/genai) × ${up} upstream`, async () => {
    const r = await gemini.models.generateContent({ model: `${UP[up]}/text`, contents: 'hi' })
    assert.equal(geminiText(r), expText[up].sync)
    assert.equal(r.candidates[0].finishReason, 'STOP')
  })
}

// =============================================================================
console.log('Streaming per ingress')

await test('responses: event sequence, assembled text, usage', async () => {
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
  assert.equal(deltaText, expText.openai.stream)
  assert.equal(completedResponse.output.find(i => i.type === 'message').content[0].text, expText.openai.stream)
  assert.ok(completedResponse.usage.input_tokens > 0)
})

await test('chat: one id across chunks, tool fragments reassemble', async () => {
  const stream = await openai.chat.completions.create({
    model: '_e2e-openai/tool-call', messages: [{ role: 'user', content: 'weather?' }], stream: true,
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }]
  })
  const ids = new Set()
  let name = null, args = ''
  for await (const chunk of stream) {
    ids.add(chunk.id)
    const tc = chunk.choices[0]?.delta?.tool_calls?.[0]
    if (tc?.function?.name) name = tc.function.name
    if (tc?.function?.arguments) args += tc.function.arguments
  }
  assert.equal(ids.size, 1)
  assert.equal(name, 'get_weather')
  assert.deepEqual(JSON.parse(args), expToolArgs)
})

await test('messages: anthropic SDK stream helper assembles the final message', async () => {
  const stream = anthropic.messages.stream({
    model: '_e2e-claude/text', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }]
  })
  const final = await stream.finalMessage()
  assert.equal(final.content.filter(b => b.type === 'text').map(b => b.text).join(''), expText.claude.stream)
})

await test('gemini: @google/genai streaming chunks assemble', async () => {
  const stream = await gemini.models.generateContentStream({ model: '_e2e-gemini/text', contents: 'hi' })
  let text = ''
  for await (const chunk of stream) {
    text += geminiText(chunk)
  }
  assert.equal(text, expText.gemini.stream)
})

await test('gemini ingress × openai upstream: fragmented tool args arrive as one functionCall', async () => {
  const stream = await gemini.models.generateContentStream({ model: '_e2e-openai/tool-call', contents: 'weather?' })
  const calls = []
  for await (const chunk of stream) {
    for (const part of chunk.candidates?.[0]?.content?.parts || []) {
      if (part.functionCall) calls.push(part.functionCall)
    }
  }
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'get_weather')
  assert.deepEqual(calls[0].args, expToolArgs)
})

// =============================================================================
console.log('Tool-result round trip: gateway must translate the tool result into each upstream wire format')
// The mock strictly validates the upstream request (ids/names/blocks) and
// returns 400 if the gateway's translation is malformed.

for (const up of UPSTREAMS) {
  await test(`responses ingress → ${up} upstream`, async () => {
    const r = await openai.responses.create({
      model: `${UP[up]}/tool-result`,
      input: [
        { role: 'user', content: 'What is the weather in Beijing right now? Use the tool.' },
        { type: 'function_call', call_id: 'call_rt_1', name: 'get_weather', arguments: '{"city":"Beijing"}' },
        { type: 'function_call_output', call_id: 'call_rt_1', output: '{"temp_c":31}' }
      ],
      tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }]
    })
    assert.equal(r.output_text, expToolResult[up].sync)
  })
}

for (const up of UPSTREAMS) {
  await test(`chat ingress → ${up} upstream`, async () => {
    const r = await openai.chat.completions.create({
      model: `${UP[up]}/tool-result`,
      messages: [
        { role: 'user', content: 'What is the weather in Beijing right now? Use the tool.' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_rt_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } }] },
        { role: 'tool', tool_call_id: 'call_rt_1', content: '{"temp_c":31}' }
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }]
    })
    assert.equal(r.choices[0].message.content, expToolResult[up].sync)
  })
}

for (const up of UPSTREAMS) {
  await test(`messages ingress → ${up} upstream`, async () => {
    const r = await anthropic.messages.create({
      model: `${UP[up]}/tool-result`,
      max_tokens: 150,
      messages: [
        { role: 'user', content: 'What is the weather in Beijing right now? Use the tool.' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_rt_1', name: 'get_weather', input: { city: 'Beijing' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_rt_1', content: '{"temp_c":31}' }] }
      ],
      tools: [{ name: 'get_weather', description: 'weather', input_schema: { type: 'object' } }]
    })
    assert.equal(r.content.filter(b => b.type === 'text').map(b => b.text).join(''), expToolResult[up].sync)
  })
}

for (const up of UPSTREAMS) {
  await test(`gemini ingress → ${up} upstream`, async () => {
    const r = await gemini.models.generateContent({
      model: `${UP[up]}/tool-result`,
      contents: [
        { role: 'user', parts: [{ text: 'What is the weather in Beijing right now? Use the tool.' }] },
        { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Beijing' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { output: '{"temp_c":31}' } } }] }
      ],
      config: { tools: [{ functionDeclarations: [{ name: 'get_weather', description: 'weather', parameters: { type: 'object' } }] }] }
    })
    assert.equal(geminiText(r), expToolResult[up].sync)
  })
}

// =============================================================================
console.log('Responses ingress specifics')

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
  assert.deepEqual(JSON.parse(args), expToolArgs)
})

await test('stream × claude upstream: thinking block + tool call', async () => {
  const stream = await openai.responses.create({ model: '_e2e-claude/tool-call', input: 'weather?', stream: true })
  let completed = null
  for await (const ev of stream) {
    if (ev.type === 'response.completed') completed = ev.response
  }
  const kinds = completed.output.map(i => i.type)
  assert.ok(kinds.includes('reasoning'), `expected a reasoning item, got ${kinds}`)
  assert.ok(kinds.includes('function_call'), `expected a function_call item, got ${kinds}`)
  assert.ok(JSON.parse(completed.output.find(i => i.type === 'function_call').arguments).city)
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
  assert.equal(completed.output.find(i => i.type === 'message').content[0].text, expText.openai.stream)
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
console.log('Truncation propagation per ingress')

await test('chat: finish_reason length', async () => {
  const stream = await openai.chat.completions.create({
    model: '_e2e-openai/truncated', messages: [{ role: 'user', content: 'count' }], stream: true
  })
  let finish = null
  for await (const chunk of stream) {
    if (chunk.choices[0]?.finish_reason) finish = chunk.choices[0].finish_reason
  }
  assert.equal(finish, 'length')
})

await test('messages: stop_reason max_tokens', async () => {
  const r = await anthropic.messages.create({
    model: '_e2e-claude/truncated', max_tokens: 8, messages: [{ role: 'user', content: 'count' }]
  })
  assert.equal(r.stop_reason, 'max_tokens')
})

await test('gemini: finishReason MAX_TOKENS', async () => {
  const r = await gemini.models.generateContent({ model: '_e2e-gemini/truncated', contents: 'count' })
  assert.equal(r.candidates[0].finishReason, 'MAX_TOKENS')
})

// =============================================================================
console.log('Claude Messages ingress specifics')

await test('tool call → tool_use block with stop_reason tool_use', async () => {
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
console.log('Legacy Completions ingress (openai SDK)')

await test('non-stream: text_completion object', async () => {
  const r = await openai.completions.create({ model: '_e2e-openai/text', prompt: 'hi', max_tokens: 50 })
  assert.equal(r.object, 'text_completion')
  assert.equal(r.choices[0].text, expText.openai.sync)
})

await test('stream: choices[].text chunks assemble', async () => {
  const stream = await openai.completions.create({ model: '_e2e-openai/text', prompt: 'hi', max_tokens: 50, stream: true })
  let text = ''
  let finish = null
  for await (const chunk of stream) {
    text += chunk.choices[0]?.text || ''
    if (chunk.choices[0]?.finish_reason) finish = chunk.choices[0].finish_reason
  }
  assert.equal(text, expText.openai.stream)
  assert.equal(finish, 'stop')
})

// =============================================================================
console.log('Claude legacy /v1/complete ingress (anthropic SDK)')

await test('non-stream: type completion', async () => {
  const r = await anthropic.completions.create({
    model: '_e2e-claude/text', prompt: '\n\nHuman: hi\n\nAssistant:', max_tokens_to_sample: 64
  })
  assert.equal(r.type, 'completion')
  assert.equal(r.completion, expText.claude.sync)
  assert.ok(['stop_sequence', 'max_tokens'].includes(r.stop_reason))
})

await test('stream: completion deltas assemble, stop_reason arrives', async () => {
  // Expected stop reason comes from the recording: legacy /v1/complete maps
  // upstream max_tokens → max_tokens, anything else → stop_sequence
  const recordedStop = rec('claude', 'text', 'stream').events
    .find(e => e.type === 'message_delta')?.delta?.stop_reason
  const expectedStop = recordedStop === 'max_tokens' ? 'max_tokens' : 'stop_sequence'

  const stream = await anthropic.completions.create({
    model: '_e2e-claude/text', prompt: '\n\nHuman: hi\n\nAssistant:', max_tokens_to_sample: 64, stream: true
  })
  let text = ''
  let stop = null
  for await (const chunk of stream) {
    text += chunk.completion || ''
    if (chunk.stop_reason) stop = chunk.stop_reason
  }
  assert.equal(text, expText.claude.stream)
  assert.equal(stop, expectedStop)
})

// =============================================================================
console.log('Embeddings')

await test('openai SDK embeddings.create', async () => {
  const recorded = rec('openai', 'embeddings', 'sync').body
  const r = await openai.embeddings.create({ model: '_e2e-openai/embeddings', input: ['hello world', 'goodbye world'] })
  assert.equal(r.object, 'list')
  assert.equal(r.data.length, recorded.data.length)
  assert.equal(r.data[0].object, 'embedding')
  assert.equal(r.data[0].embedding.length, recorded.data[0].embedding.length)
  assert.ok(Math.abs(r.data[0].embedding[0] - recorded.data[0].embedding[0]) < 1e-6)
  assert.equal(r.usage.prompt_tokens, recorded.usage.prompt_tokens)
})

await test('gemini wire format: embedContent and batchEmbedContents', async () => {
  const recorded = rec('gemini', 'embeddings', 'sync').body
  const gfetch = (p, body) => fetch(`${GATEWAY}/api/gemini/v1beta/${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify(body)
  })

  const single = await gfetch('models/_e2e-gemini/embeddings:embedContent', {
    content: { parts: [{ text: 'hello world' }] }
  })
  assert.equal(single.status, 200)
  const sd = await single.json()
  assert.equal(sd.embedding.values.length, recorded.embeddings[0].values.length)

  const batch = await gfetch('models/_e2e-gemini/embeddings:batchEmbedContents', {
    requests: [
      { content: { parts: [{ text: 'hello world' }] } },
      { content: { parts: [{ text: 'goodbye world' }] } }
    ]
  })
  assert.equal(batch.status, 200)
  const bd = await batch.json()
  assert.equal(bd.embeddings.length, 2)
  assert.equal(bd.embeddings[0].values.length, recorded.embeddings[0].values.length)
})

// =============================================================================
console.log('Gemini ingress wire-format details')

await test('streamGenerateContent without alt=sse returns a JSON array', async () => {
  const r = await fetch(`${GATEWAY}/api/gemini/v1beta/models/_e2e-gemini/text:streamGenerateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
  })
  assert.equal(r.status, 200)
  const d = await r.json()
  assert.ok(Array.isArray(d), 'expected a JSON array of chunks')
  const text = d.flatMap(e => e.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('')
  assert.equal(text, expText.gemini.stream)
})

// =============================================================================
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
