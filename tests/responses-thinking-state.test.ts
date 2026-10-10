import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { OpenAIResponsesSerializer } from '../builtin/ingress-openai/openai-responses-serializer.ts'
import { OpenAIResponsesParser } from '../builtin/ingress-openai/openai-responses.ts'
import { decodeThinkingState, encodeThinkingState } from '../builtin/provider-openai/responses-thinking-state.ts'

const require = createRequire(import.meta.url)
const { AntigravityAdapter } = require(`${process.env.ADAPTER_BUILD}/../builtin/provider-antigravity/antigravity.js`)
const signed = { type: 'thinking' as const, thinking: '原始思考', signature: 'opaque-signature' }
assert.deepEqual(decodeThinkingState(encodeThinkingState([signed])), [signed])
assert.equal(decodeThinkingState('native-openai-state'), undefined)
for (const invalid of ['llmhub:thinking:v2:abc', 'llmhub:thinking:v1:bad', 'llmhub:thinking:v1:W10']) {
  assert.throws(() => decodeThinkingState(invalid), (error: any) => error.statusCode === 400)
}

const serializer = new OpenAIResponsesSerializer()
const events = [
  ...serializer.serializeStreamChunk({ type: 'thinking', delta: signed.thinking }),
  ...serializer.serializeStreamChunk({ type: 'thinking', signature: 'opaque-' }),
  ...serializer.serializeStreamChunk({ type: 'thinking', signature: 'signature' }),
  ...serializer.serializeStreamChunk({ type: 'content', delta: 'hello' }),
  ...serializer.serializeStreamChunk({ type: 'done', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } })
]
const streamOutput = events.find(event => event.event === 'response.completed')!.data.response.output
assert.deepEqual(decodeThinkingState(streamOutput[0].encrypted_content), [signed])
assert.equal(events.find(event => event.event === 'response.output_item.done')!.data.item.encrypted_content, streamOutput[0].encrypted_content)
const syncOutput = new OpenAIResponsesSerializer().serializeResponse({
  content: [signed, { type: 'text', text: 'hello' }], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 }
}).output
for (const output of [streamOutput, syncOutput]) {
  const request = new OpenAIResponsesParser().parseRequest({
    model: 'antigravity/claude-opus-5-5-high', input: [
      { role: 'user', content: 'hi' }, ...output, { role: 'user', content: 'again' }
    ]
  })
  const adapter = new AntigravityAdapter({ name: 'antigravity', connection: {}, models: [] })
  const parts = adapter.toProviderRequest(request).payload.contents[1].parts
  assert.deepEqual(parts, [{ text: signed.thinking, thought: true, thoughtSignature: signed.signature }, { text: 'hello' }])
}
const native = new OpenAIResponsesParser().parseRequest({ input: [{ type: 'reasoning', encrypted_content: 'native-openai-state', summary: [] }] })
assert.deepEqual(native.messages[0].content, [{ type: 'redacted_thinking', data: 'native-openai-state', reasoningProvider: 'openai' }])
console.log('ok - Responses signed thinking sync/stream replay, native state and invalid envelopes')

for (const toolOutput of ['tool succeeded', 'tool failed: memory store is busy']) {
  const adapter = new AntigravityAdapter({ name: 'antigravity', connection: {}, models: [] })
  const serializer = new OpenAIResponsesSerializer()
  const state = {}
  const upstream = [
    { candidates: [{ content: { parts: [{ thought: true, text: signed.thinking, thoughtSignature: signed.signature }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { id: 'toolu_original', name: 'memory', args: { action: 'recall' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }
  ]
  const events = upstream.flatMap(chunk => {
    const converted = adapter.fromProviderStreamChunk(chunk, state)
    return (Array.isArray(converted) ? converted : [converted]).flatMap(value => serializer.serializeStreamChunk(value))
  })
  const output = events.find(event => event.event === 'response.completed')!.data.response.output
  const call = output.find((item: any) => item.type === 'function_call')
  assert.equal(call.call_id, 'toolu_original')
  const request = new OpenAIResponsesParser().parseRequest({
    model: 'antigravity/claude-opus-5-5-high', input: [
      { role: 'user', content: 'Recall memory' }, ...output,
      { type: 'function_call_output', call_id: call.call_id, output: toolOutput }
    ]
  })
  const contents = adapter.toProviderRequest(request).payload.contents
  const calls = contents[1].parts.filter((part: any) => part.functionCall)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].functionCall, { id: 'toolu_original', name: 'memory', args: { action: 'recall' } })
  assert.equal(contents[1].parts[0].thoughtSignature, signed.signature)
  assert.equal(contents[2].parts[0].functionResponse.id, 'toolu_original')
  assert.equal(contents[2].parts[0].functionResponse.response.output, toolOutput)
}
console.log('ok - Responses tool success/failure replay preserves call/result IDs and thinking signatures')

for (const model of ['claude-opus-5-5-high', 'gemini-3-flash', 'custom-alias']) {
  const adapter = new AntigravityAdapter({ name: 'antigravity', connection: {}, models: [] })
  for (const useContentBlock of [false, true]) {
    const request = {
      model: `antigravity/${model}`, config: {}, messages: [{
        role: 'assistant',
        content: [signed, ...(useContentBlock ? [{ type: 'tool_use', toolUse: { id: 'call-1', name: 'memory', input: {} } }] : [])],
        ...(!useContentBlock ? { meta: { toolCalls: [{ id: 'call-1', name: 'memory', input: {} }] } } : {})
      }]
    }
    const original = structuredClone(request)
    const parts = adapter.toProviderRequest(request).payload.contents[0].parts
    assert.equal(parts[0].thoughtSignature, signed.signature)
    const call = parts.find((part: any) => part.functionCall)
    assert.equal(call.functionCall.id, 'call-1')
    assert.equal(call.thought_signature, undefined)
    assert.deepEqual(request, original)
  }
  const parts = adapter.toProviderRequest({
    model: `antigravity/${model}`, config: {}, messages: [{ role: 'assistant', content: [signed],
      meta: { toolCalls: [{ id: 'call-1', name: 'memory', input: {}, thoughtSignature: 'real-tool-signature' }] }
    }]
  }).payload.contents[0].parts
  assert.equal(parts[1].thought_signature, 'real-tool-signature')
}
const unsignedAdapter = new AntigravityAdapter({ name: 'antigravity', connection: {}, models: [] })
const mixed = unsignedAdapter.toProviderRequest({ model: 'antigravity/custom-alias', config: {}, messages: [
  { role: 'assistant', content: [signed] },
  { role: 'user', content: 'next' },
  { role: 'assistant', content: '', meta: { toolCalls: [{ id: 'unsigned', name: 'memory', input: {} }] } }
]}).payload.contents
assert.equal(mixed[2].parts[0].thought_signature, 'skip_thought_signature_validator')
console.log('ok - Signature presence, not model names, controls placeholders per assistant message')
