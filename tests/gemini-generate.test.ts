import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// The gemini parser has a value import without an extension (sanitize-gemini-schema),
// which Node's native TS loader cannot resolve — use the tsc-compiled build instead.
const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) {
  console.error('ADAPTER_BUILD not set — run via tests/run-all.sh')
  process.exit(1)
}
const { GeminiAdapter } = require(`${buildDir}/providers/gemini.js`)
const { GeminiGenerateParser } = require(`${buildDir}/protocols/gemini-generate.js`)
const { GeminiGenerateSerializer } = require(`${buildDir}/protocols/gemini-generate-serializer.js`)

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

console.log('gemini-generate parser')

test('contents, systemInstruction and generationConfig are parsed', () => {
  const req = new GeminiGenerateParser().parseRequest({
    systemInstruction: { parts: [{ text: 'be brief' }] },
    contents: [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] }
    ],
    generationConfig: { maxOutputTokens: 99, temperature: 0.5, topP: 0.9, stopSequences: ['END'] }
  }, 'p/m')
  assert.equal(req.model, 'p/m')
  assert.equal(req.config.systemPrompt, 'be brief')
  assert.equal(req.config.maxTokens, 99)
  assert.equal(req.config.topP, 0.9)
  assert.deepEqual(req.config.stop, ['END'])
  assert.equal(req.messages[0].role, 'user')
  assert.equal(req.messages[1].role, 'assistant')
  assert.deepEqual(req.messages[1].content, [{ type: 'text', text: 'hello' }])
})

test('model history parts with thought:true parse as thinking blocks, not text', () => {
  const req = new GeminiGenerateParser().parseRequest({
    contents: [
      { role: 'user', parts: [{ text: 'hi' }] },
      {
        role: 'model',
        parts: [
          { text: 'let me think...', thought: true },
          { text: 'the answer is 42' }
        ]
      }
    ]
  }, 'p/m')
  const blocks = req.messages[1].content as any[]
  assert.deepEqual(blocks[0], { type: 'thinking', thinking: 'let me think...' })
  assert.deepEqual(blocks[1], { type: 'text', text: 'the answer is 42' })
})

test('round-trip: parsed thought parts keep thought:true when sent back to gemini', () => {
  const req = new GeminiGenerateParser().parseRequest({
    contents: [
      { role: 'user', parts: [{ text: 'hi' }] },
      {
        role: 'model',
        parts: [
          { text: 'let me think...', thought: true },
          { text: 'the answer is 42' }
        ]
      }
    ]
  }, 'p/m')
  const { payload } = new GeminiAdapter(dummyConfig).toProviderRequest(req)
  assert.deepEqual(payload.contents[1].parts, [
    { text: 'let me think...', thought: true },
    { text: 'the answer is 42' }
  ])
})

test('functionCall / functionResponse parts become tool meta', () => {
  const req = new GeminiGenerateParser().parseRequest({
    contents: [
      { role: 'user', parts: [{ text: 'weather?' }] },
      { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'get_weather', args: { city: 'sf' } } }] },
      { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'get_weather', response: { output: 'sunny' } } }] }
    ]
  }, 'p/m')
  const assistant = req.messages[1]
  assert.deepEqual(assistant.meta.toolCalls, [{ id: 'c1', name: 'get_weather', input: { city: 'sf' } }])
  const toolMsg = req.messages[2]
  assert.equal(toolMsg.role, 'tool')
  assert.equal(toolMsg.meta.toolCallId, 'c1')
  assert.equal(toolMsg.meta.name, 'get_weather')
  assert.deepEqual(toolMsg.content, [{ type: 'text', text: 'sunny' }])
})

test('functionResponse without id reuses the id minted for the matching functionCall', () => {
  const req = new GeminiGenerateParser().parseRequest({
    contents: [
      { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { output: 'ok' } } }] }
    ]
  }, 'p/m')
  const mintedId = req.messages[0].meta.toolCalls[0].id
  assert.ok(mintedId)
  assert.equal(req.messages[1].role, 'tool')
  assert.equal(req.messages[1].meta.toolCallId, mintedId)
})

test('tools functionDeclarations are flattened and schema-sanitized', () => {
  const req = new GeminiGenerateParser().parseRequest({
    contents: [{ role: 'user', parts: [{ text: 'x' }] }],
    tools: [{ functionDeclarations: [{ name: 'f', description: 'd', parameters: { type: 'object', properties: {} } }] }]
  }, 'p/m')
  assert.equal(req.tools!.length, 1)
  assert.equal(req.tools![0].name, 'f')
})

test('inlineData and fileData parts become image blocks', () => {
  const req = new GeminiGenerateParser().parseRequest({
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { data: 'AAAA', mimeType: 'image/png' } },
        { fileData: { fileUri: 'https://x/img.jpg', mimeType: 'image/jpeg' } }
      ]
    }]
  }, 'p/m')
  const blocks = req.messages[0].content as any[]
  assert.deepEqual(blocks[0], { type: 'image', imageBase64: 'AAAA', imageMediaType: 'image/png' })
  assert.deepEqual(blocks[1], { type: 'image', imageUrl: 'https://x/img.jpg', imageMediaType: 'image/jpeg' })
})

console.log('gemini-generate serializer (non-stream)')

test('text + thinking + tool calls serialize to candidate parts', () => {
  const out = new GeminiGenerateSerializer().serializeResponse({
    content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'hi' }],
    finishReason: 'tool_calls',
    toolCalls: [{ id: 'c1', name: 'f', input: { a: 1 } }],
    usage: { promptTokens: 3, completionTokens: 4 }
  })
  const parts = out.candidates[0].content.parts
  assert.deepEqual(parts[0], { text: 'hmm', thought: true })
  assert.deepEqual(parts[1], { text: 'hi' })
  assert.deepEqual(parts[2].functionCall, { id: 'c1', name: 'f', args: { a: 1 } })
  assert.equal(out.candidates[0].finishReason, 'STOP')
  assert.deepEqual(out.usageMetadata, { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 })
})

test('length maps to MAX_TOKENS; malformed string args do not crash', () => {
  const out = new GeminiGenerateSerializer().serializeResponse({
    content: 'cut',
    finishReason: 'length',
    toolCalls: [{ id: 'c1', name: 'f', input: '{broken json' }],
    usage: { promptTokens: 1, completionTokens: 1 }
  })
  assert.equal(out.candidates[0].finishReason, 'MAX_TOKENS')
  assert.deepEqual(out.candidates[0].content.parts[1].functionCall.args, {})
})

console.log('gemini-generate serializer (stream)')

test('content/thinking deltas pass through; empty deltas are suppressed (null)', () => {
  const s = new GeminiGenerateSerializer()
  const c = s.serializeStreamChunk({ type: 'content', delta: 'hi' })
  assert.deepEqual(c.candidates[0].content.parts, [{ text: 'hi' }])
  const t = s.serializeStreamChunk({ type: 'thinking', delta: 'mm' })
  assert.deepEqual(t.candidates[0].content.parts, [{ text: 'mm', thought: true }])
  assert.equal(s.serializeStreamChunk({ type: 'content', delta: '' }), null)
})

test('fragmented tool args buffer until done, then flush as complete functionCall', () => {
  const s = new GeminiGenerateSerializer()
  // openai-style fragments: id+name first, then partial arg chunks
  assert.equal(s.serializeStreamChunk({ type: 'tool_call', toolCall: { id: 'c1', name: 'f' } }), null)
  assert.equal(s.serializeStreamChunk({ type: 'tool_call', toolCall: { inputDelta: '{"a":' } }), null)
  assert.equal(s.serializeStreamChunk({ type: 'tool_call', toolCall: { inputDelta: '1}' } }), null)
  const done = s.serializeStreamChunk({ type: 'done', finishReason: 'tool_calls', usage: { promptTokens: 1, completionTokens: 2 } })
  const parts = done.candidates[0].content.parts
  assert.equal(parts.length, 1)
  assert.deepEqual(parts[0].functionCall, { id: 'c1', name: 'f', args: { a: 1 } })
  assert.equal(done.candidates[0].finishReason, 'STOP')
  assert.equal(done.usageMetadata.totalTokenCount, 3)
})

test('two complete tool calls (gemini-style) both flush at done', () => {
  const s = new GeminiGenerateSerializer()
  s.serializeStreamChunk({ type: 'tool_call', toolCall: { id: 'c1', name: 'f', inputDelta: '{"x":1}' } })
  s.serializeStreamChunk({ type: 'tool_call', toolCall: { id: 'c2', name: 'g', inputDelta: '{}' } })
  const done = s.serializeStreamChunk({ type: 'done', finishReason: 'tool_calls' })
  const parts = done.candidates[0].content.parts
  assert.deepEqual(parts.map((p: any) => p.functionCall.name), ['f', 'g'])
  assert.deepEqual(parts[0].functionCall.args, { x: 1 })
})

test('done without prior tools has empty parts and MAX_TOKENS on length', () => {
  const s = new GeminiGenerateSerializer()
  const done = s.serializeStreamChunk({ type: 'done', finishReason: 'length' })
  assert.deepEqual(done.candidates[0].content.parts, [])
  assert.equal(done.candidates[0].finishReason, 'MAX_TOKENS')
})

console.log('gemini adapter')

test('toProviderRequest converts messages, system and tools', () => {
  const adapter = new GeminiAdapter(dummyConfig)
  const { modelId, payload } = adapter.toProviderRequest({
    model: 'prov/gemini-x',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', meta: { toolCalls: [{ id: 'c1', name: 'f', input: { a: 1 } }] } },
      { role: 'tool', content: 'result', meta: { toolCallId: 'c1', name: 'f' } }
    ],
    config: { maxTokens: 50, temperature: 0.1, systemPrompt: 'sys' },
    tools: [{ name: 'f', description: 'd', parameters: { type: 'object' } }]
  })
  assert.equal(modelId, 'gemini-x')
  assert.equal(payload.systemInstruction.parts[0].text, 'sys')
  assert.equal(payload.contents[0].role, 'user')
  assert.equal(payload.contents[1].parts[0].functionCall.name, 'f')
  assert.deepEqual(payload.contents[2].parts[0].functionResponse.response, { output: 'result' })
  assert.equal(payload.tools[0].functionDeclarations[0].name, 'f')
  assert.equal(payload.generationConfig.maxOutputTokens, 50)
})

test('fromProviderResponse maps parts, thoughts and finish reasons', () => {
  const adapter = new GeminiAdapter(dummyConfig)
  const r = adapter.fromProviderResponse({
    candidates: [{
      content: { parts: [{ text: 'think', thought: true }, { text: 'answer' }] },
      finishReason: 'MAX_TOKENS'
    }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6 }
  })
  assert.deepEqual(r.content[0], { type: 'thinking', thinking: 'think' })
  assert.deepEqual(r.content[1], { type: 'text', text: 'answer' })
  assert.equal(r.finishReason, 'length')
  assert.equal(r.usage.promptTokens, 5)
})

test('fromProviderStreamChunk: text, functionCall and finish', () => {
  const adapter = new GeminiAdapter(dummyConfig)
  const state = {}
  const c1 = adapter.fromProviderStreamChunk({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }, state)
  assert.deepEqual(c1, { type: 'content', delta: 'hi' })

  const c2 = adapter.fromProviderStreamChunk({
    candidates: [{ content: { parts: [{ functionCall: { id: 'c1', name: 'f', args: { a: 1 } } }] } }]
  }, state)
  const tc = Array.isArray(c2) ? c2[0] : c2
  assert.equal(tc.type, 'tool_call')
  assert.equal(tc.toolCall.name, 'f')
  assert.equal(tc.toolCall.inputDelta, '{"a":1}')

  const c3 = adapter.fromProviderStreamChunk({
    candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 }
  }, state)
  const done = (Array.isArray(c3) ? c3 : [c3]).find((c: any) => c.type === 'done')
  // a tool call was seen earlier in this stream → finish must be tool_calls
  assert.equal(done.finishReason, 'tool_calls')
  assert.deepEqual(done.usage, { promptTokens: 1, completionTokens: 2 })
})

test('fromProviderStreamChunk: MAX_TOKENS maps to length', () => {
  const adapter = new GeminiAdapter(dummyConfig)
  const out = adapter.fromProviderStreamChunk({
    candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }]
  }, {})
  const done = (Array.isArray(out) ? out : [out]).find((c: any) => c.type === 'done')
  assert.equal(done.finishReason, 'length')
})

console.log(`\n${passed} tests passed${process.exitCode ? ', with FAILURES' : ''}`)
