import assert from 'node:assert/strict'
import { OpenAICompletionSerializer } from '../server/protocols/openai-completion-serializer.ts'
import { OpenAICompletionParser } from '../server/protocols/openai-completion.ts'

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

console.log('openai-completion parser')

test('prompt becomes a user message with sampling params', () => {
  const req = new OpenAICompletionParser().parseRequest({
    model: 'm', prompt: 'Once upon', max_tokens: 50, temperature: 0.9, top_p: 0.8, stop: ['\n']
  })
  assert.deepEqual(req.messages, [{ role: 'user', content: 'Once upon' }])
  assert.equal(req.config.maxTokens, 50)
  assert.deepEqual(req.config.stop, ['\n'])
})

console.log('openai-completion serializer (non-stream)')

test('returns object text_completion with choices[].text', () => {
  const out = new OpenAICompletionSerializer().serializeResponse({
    content: [{ type: 'text', text: 'a time' }],
    finishReason: 'stop',
    usage: { promptTokens: 2, completionTokens: 3 }
  })
  assert.equal(out.object, 'text_completion')
  assert.match(out.id, /^cmpl-/)
  assert.deepEqual(out.choices, [{ text: 'a time', index: 0, logprobs: null, finish_reason: 'stop' }])
  assert.deepEqual(out.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 })
})

test('string content and length finish reason', () => {
  const out = new OpenAICompletionSerializer().serializeResponse({
    content: 'truncated',
    finishReason: 'length',
    usage: { promptTokens: 1, completionTokens: 1 }
  })
  assert.equal(out.choices[0].text, 'truncated')
  assert.equal(out.choices[0].finish_reason, 'length')
})

console.log('openai-completion serializer (stream)')

test('content chunks carry choices[].text, share one id, finish carries reason', () => {
  const s = new OpenAICompletionSerializer()
  const c1 = s.serializeStreamChunk({ type: 'content', delta: 'he' })
  const c2 = s.serializeStreamChunk({ type: 'content', delta: 'llo' })
  const done = s.serializeStreamChunk({ type: 'done', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2 } })

  assert.equal(c1.object, 'text_completion')
  assert.equal(c1.choices[0].text, 'he')
  assert.equal(c1.choices[0].finish_reason, null)
  assert.equal(c2.choices[0].text, 'llo')
  assert.equal(c1.id, c2.id)
  assert.equal(c1.id, done.id)
  assert.equal(done.choices[0].finish_reason, 'stop')
  assert.deepEqual(done.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 })
})

console.log(`\n${passed} tests passed${process.exitCode ? ', with FAILURES' : ''}`)
