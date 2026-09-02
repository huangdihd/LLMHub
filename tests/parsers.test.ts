import assert from 'node:assert/strict'
import { OpenAIChatParser } from '../server/protocols/openai-chat.ts'
import { ClaudeMessagesParser } from '../server/protocols/claude-messages.ts'
import { ClaudeMessagesSerializer } from '../server/protocols/claude-messages-serializer.ts'

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

console.log('openai-chat parser')

test('multiple system/developer messages concatenate instead of overwriting', () => {
  const req = new OpenAIChatParser().parseRequest({
    messages: [
      { role: 'system', content: 'A' },
      { role: 'developer', content: [{ type: 'text', text: 'B' }] },
      { role: 'user', content: 'hi' }
    ]
  })
  assert.equal(req.config.systemPrompt, 'A\nB')
  assert.equal(req.messages.length, 1)
})

test('null system content does not crash', () => {
  const req = new OpenAIChatParser().parseRequest({
    messages: [{ role: 'system', content: null }, { role: 'user', content: 'hi' }]
  })
  assert.equal(req.config.systemPrompt, '')
})

test('assistant tool_calls become meta.toolCalls with parsed args', () => {
  const req = new OpenAIChatParser().parseRequest({
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'sunny' }
    ]
  })
  assert.deepEqual(req.messages[1].meta.toolCalls, [{ id: 'c1', name: 'f', input: { a: 1 } }])
  assert.equal(req.messages[2].meta.toolCallId, 'c1')
  assert.equal(req.messages[2].meta.name, 'f')
})

test('malformed tool arguments fall back to {} instead of crashing', () => {
  const req = new OpenAIChatParser().parseRequest({
    messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{bad' } }] }]
  })
  assert.deepEqual(req.messages[0].meta.toolCalls[0].input, {})
})

test('image_url parts: data URI → base64 block, https → url block', () => {
  const req = new OpenAIChatParser().parseRequest({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'see' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'image_url', image_url: { url: 'https://x/a.png' } }
      ]
    }]
  })
  const blocks = req.messages[0].content as any[]
  assert.deepEqual(blocks[1], { type: 'image', imageBase64: 'AAAA', imageMediaType: 'image/png' })
  assert.deepEqual(blocks[2], { type: 'image', imageUrl: 'https://x/a.png' })
})

test('reasoning_content becomes a thinking block; tool_choice and tools parse', () => {
  const req = new OpenAIChatParser().parseRequest({
    messages: [{ role: 'assistant', content: 'ans', reasoning_content: 'think' }],
    tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'f' } }
  })
  assert.deepEqual(req.messages[0].content, [
    { type: 'thinking', thinking: 'think' },
    { type: 'text', text: 'ans' }
  ])
  assert.deepEqual(req.tools, [{ name: 'f', description: 'd', parameters: { type: 'object' } }])
  assert.deepEqual(req.toolChoice, { name: 'f' })
})

console.log('claude-messages parser')

test('system array, sampling params and tools parse', () => {
  const req = new ClaudeMessagesParser().parseRequest({
    system: [{ type: 'text', text: 'S1' }, { type: 'text', text: 'S2' }],
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 77,
    stop_sequences: ['X'],
    tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }],
    tool_choice: { type: 'any' }
  })
  assert.equal(req.config.systemPrompt, 'S1S2')
  assert.equal(req.config.maxTokens, 77)
  assert.deepEqual(req.tools, [{ name: 'f', description: 'd', parameters: { type: 'object' } }])
  assert.equal(req.toolChoice, 'required')
})

test('tool_use blocks → meta.toolCalls; tool_result → meta.toolCallId', () => {
  const req = new ClaudeMessagesParser().parseRequest({
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sunny' }] }
    ]
  })
  assert.deepEqual(req.messages[1].meta.toolCalls, [{ id: 't1', name: 'f', input: { a: 1 } }])
  assert.equal(req.messages[2].meta.toolCallId, 't1')
  const trBlock = (req.messages[2].content as any[])[0]
  assert.equal(trBlock.type, 'tool_result')
  assert.equal(trBlock.toolResult.content, 'sunny')
})

test('structured tool_result content is preserved', () => {
  const req = new ClaudeMessagesParser().parseRequest({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'x' }] }] }]
  })
  const tr = (req.messages[0].content as any[])[0]
  assert.deepEqual(tr.toolResult.content, [{ type: 'text', text: 'x' }])
})

test('image blocks: base64 source and url source', () => {
  const req = new ClaudeMessagesParser().parseRequest({
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'image', source: { type: 'url', url: 'https://x/a.png' } }
      ]
    }]
  })
  const blocks = req.messages[0].content as any[]
  assert.deepEqual(blocks[0], { type: 'image', imageBase64: 'AAAA', imageMediaType: 'image/png' })
  assert.deepEqual(blocks[1], { type: 'image', imageUrl: 'https://x/a.png' })
})

test('thinking and redacted_thinking blocks pass through', () => {
  const req = new ClaudeMessagesParser().parseRequest({
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'mm', signature: 'signed' }, { type: 'redacted_thinking', data: 'opaque' }] }]
  })
  const blocks = req.messages[0].content as any[]
  assert.deepEqual(blocks[0], { type: 'thinking', thinking: 'mm', signature: 'signed', reasoningProvider: 'anthropic' })
  assert.deepEqual(blocks[1], { type: 'redacted_thinking', data: 'opaque', reasoningProvider: 'anthropic' })
})

console.log('claude-messages serializer')

test('non-stream response has full message shape', () => {
  const out = new ClaudeMessagesSerializer().serializeResponse({
    content: [{ type: 'thinking', thinking: 'mm' }, { type: 'text', text: 'hi' }],
    finishReason: 'tool_calls',
    toolCalls: [{ id: 't1', name: 'f', input: { a: 1 } }],
    usage: { promptTokens: 3, completionTokens: 4 }
  })
  assert.equal(out.type, 'message')
  assert.equal(out.role, 'assistant')
  assert.deepEqual(out.content[0], { type: 'thinking', thinking: 'mm' })
  assert.deepEqual(out.content[1], { type: 'text', text: 'hi' })
  assert.deepEqual(out.content[2], { type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } })
  assert.equal(out.stop_reason, 'tool_use')
  assert.equal(out.stop_sequence, null)
  assert.deepEqual(out.usage, { input_tokens: 3, output_tokens: 4 })
})

test('stream chunks: text/thinking deltas and tool blocks', () => {
  const s = new ClaudeMessagesSerializer()
  assert.deepEqual(s.serializeStreamChunk({ type: 'content', delta: 'hi' }).delta, { type: 'text_delta', text: 'hi' })
  assert.deepEqual(s.serializeStreamChunk({ type: 'thinking', delta: 'mm' }).delta, { type: 'thinking_delta', thinking: 'mm' })

  const start = s.serializeStreamChunk({ type: 'tool_call', toolCall: { id: 't1', name: 'f' } })
  assert.equal(start.type, 'content_block_start')
  assert.deepEqual(start.content_block, { type: 'tool_use', id: 't1', name: 'f' })

  const delta = s.serializeStreamChunk({ type: 'tool_call', toolCall: { inputDelta: '{"a"' } })
  assert.deepEqual(delta.delta, { type: 'input_json_delta', partial_json: '{"a"' })

  const done = s.serializeStreamChunk({ type: 'done', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 9 } })
  assert.equal(done.type, 'message_delta')
  assert.equal(done.delta.stop_reason, 'end_turn')
  assert.equal(done.usage.output_tokens, 9)
})

console.log(`\n${passed} tests passed${process.exitCode ? ', with FAILURES' : ''}`)
