import assert from 'node:assert/strict'
import { OpenAIChatSerializer } from '../server/protocols/openai-chat-serializer.ts'

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

console.log('openai-chat serializer')

test('all chunks of one stream share the same id and created timestamp', () => {
  const s = new OpenAIChatSerializer()
  const c1 = s.serializeStreamChunk({ type: 'content', delta: 'a' })
  const c2 = s.serializeStreamChunk({ type: 'content', delta: 'b' })
  const done = s.serializeStreamChunk({ type: 'done', finishReason: 'stop' })

  assert.match(c1.id, /^chatcmpl-/)
  assert.equal(c1.id, c2.id)
  assert.equal(c1.id, done.id)
  assert.equal(c1.created, done.created)
})

test('two streams (instances) get different ids', () => {
  const a = new OpenAIChatSerializer().serializeStreamChunk({ type: 'content', delta: 'x' })
  const b = new OpenAIChatSerializer().serializeStreamChunk({ type: 'content', delta: 'x' })
  assert.notEqual(a.id, b.id)
})

test('tool call deltas still serialize correctly', () => {
  const s = new OpenAIChatSerializer()
  const start = s.serializeStreamChunk({ type: 'tool_call', toolCall: { index: 0, id: 'c1', name: 'f' } })
  assert.equal(start.choices[0].delta.tool_calls[0].id, 'c1')
  assert.equal(start.choices[0].delta.tool_calls[0].function.name, 'f')
  const delta = s.serializeStreamChunk({ type: 'tool_call', toolCall: { index: 0, inputDelta: '{"a":1}' } })
  assert.equal(delta.choices[0].delta.tool_calls[0].function.arguments, '{"a":1}')
})

console.log(`\n${passed} tests passed${process.exitCode ? ', with FAILURES' : ''}`)
