import assert from 'node:assert/strict'
import { ClaudeCompletionParser } from '../server/protocols/claude-completion.ts'
import { ClaudeCompletionSerializer } from '../server/protocols/claude-completion-serializer.ts'

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

console.log('claude-completion parser')

test('prompt and params are parsed', () => {
  const req = new ClaudeCompletionParser().parseRequest({
    model: 'm',
    prompt: '\n\nHuman: hi\n\nAssistant:',
    max_tokens_to_sample: 128,
    stop_sequences: ['\n\nHuman:']
  })
  assert.equal(req.messages[0].content, '\n\nHuman: hi\n\nAssistant:')
  assert.equal(req.config.maxTokens, 128)
  assert.deepEqual(req.config.stop, ['\n\nHuman:'])
})

test('parseStreamChunk understands real completion events (not hallucinated ones)', () => {
  const p = new ClaudeCompletionParser()
  const delta = p.parseStreamChunk({ type: 'completion', completion: ' Hello', stop_reason: null })
  assert.deepEqual(delta, { type: 'content', delta: ' Hello' })

  const stop = p.parseStreamChunk({ type: 'completion', completion: '', stop_reason: 'stop_sequence' })
  assert.equal(stop.type, 'done')
  assert.equal(stop.finishReason, 'stop')

  const truncated = p.parseStreamChunk({ type: 'completion', completion: '', stop_reason: 'max_tokens' })
  assert.equal(truncated.finishReason, 'length')
})

console.log('claude-completion serializer (non-stream)')

test('returns type completion with stop_reason', () => {
  const out = new ClaudeCompletionSerializer().serializeResponse({
    content: [{ type: 'text', text: ' Hello!' }],
    finishReason: 'stop',
    usage: { promptTokens: 1, completionTokens: 2 }
  })
  assert.equal(out.type, 'completion')
  assert.equal(out.completion, ' Hello!')
  assert.equal(out.stop_reason, 'stop_sequence')
  assert.match(out.id, /^compl_/)
})

test('length maps to max_tokens', () => {
  const out = new ClaudeCompletionSerializer().serializeResponse({
    content: 'cut',
    finishReason: 'length',
    usage: { promptTokens: 1, completionTokens: 2 }
  })
  assert.equal(out.stop_reason, 'max_tokens')
})

console.log('claude-completion serializer (stream)')

test('deltas carry completion text with null stop_reason; done sets it', () => {
  const s = new ClaudeCompletionSerializer()
  const c1 = s.serializeStreamChunk({ type: 'content', delta: ' Hel' })
  const c2 = s.serializeStreamChunk({ type: 'content', delta: 'lo' })
  const done = s.serializeStreamChunk({ type: 'done', finishReason: 'stop' })

  assert.equal(c1.type, 'completion')
  assert.equal(c1.completion, ' Hel')
  assert.equal(c1.stop_reason, null)
  assert.equal(c2.completion, 'lo')
  assert.equal(c1.id, done.id)
  assert.equal(done.completion, '')
  assert.equal(done.stop_reason, 'stop_sequence')
})

console.log(`\n${passed} tests passed${process.exitCode ? ', with FAILURES' : ''}`)
