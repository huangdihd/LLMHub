import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { OpenAIResponsesSerializer } from '../server/protocols/openai-responses-serializer.ts'
import { OpenAIResponsesParser } from '../server/protocols/openai-responses.ts'
import { decodeThinkingState, encodeThinkingState } from '../server/utils/responses-thinking-state.ts'

const require = createRequire(import.meta.url)
const { AntigravityAdapter } = require(`${process.env.ADAPTER_BUILD}/providers/antigravity.js`)
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
