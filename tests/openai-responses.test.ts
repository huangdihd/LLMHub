import assert from 'node:assert/strict'
import { OpenAIResponsesParser } from '../server/protocols/openai-responses.ts'
import { OpenAIResponsesSerializer } from '../server/protocols/openai-responses-serializer.ts'

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

console.log('openai-responses parser')

test('string input becomes a single user message', () => {
  const req = new OpenAIResponsesParser().parseRequest({ model: 'm', input: 'hello' })
  assert.deepEqual(req.messages, [{ role: 'user', content: 'hello' }])
})

test('system/developer items and instructions merge into systemPrompt', () => {
  const req = new OpenAIResponsesParser().parseRequest({
    instructions: 'INST',
    input: [
      { role: 'system', content: 'SYS' },
      { role: 'developer', content: [{ type: 'input_text', text: 'DEV' }] },
      { role: 'user', content: 'hi' }
    ]
  })
  assert.equal(req.config.systemPrompt, 'INST\nSYS\nDEV')
  assert.equal(req.messages.length, 1)
  assert.equal(req.messages[0].role, 'user')
})

test('function_call items merge into one assistant message with parsed arguments', () => {
  const req = new OpenAIResponsesParser().parseRequest({
    input: [
      { role: 'user', content: 'hi' },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"sf"}' },
      { type: 'function_call', call_id: 'call_2', name: 'get_time', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'sunny' }
    ]
  })
  assert.equal(req.messages.length, 3)
  const assistant = req.messages[1]
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.meta.toolCalls.length, 2)
  assert.deepEqual(assistant.meta.toolCalls[0], { id: 'call_1', name: 'get_weather', input: { city: 'sf' } })
  const tool = req.messages[2]
  assert.equal(tool.role, 'tool')
  assert.equal(tool.content, 'sunny')
  assert.equal(tool.meta.toolCallId, 'call_1')
  assert.equal(tool.meta.name, 'get_weather')
})

test('input_image with string image_url (Responses format)', () => {
  const req = new OpenAIResponsesParser().parseRequest({
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'what is this' },
        { type: 'input_image', image_url: 'https://example.com/a.png' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }
      ]
    }]
  })
  const blocks = req.messages[0].content as any[]
  assert.deepEqual(blocks[0], { type: 'text', text: 'what is this' })
  assert.deepEqual(blocks[1], { type: 'image', imageUrl: 'https://example.com/a.png' })
  assert.deepEqual(blocks[2], { type: 'image', imageBase64: 'AAAA', imageMediaType: 'image/png' })
})

test('assistant output_text content from previous turns is preserved', () => {
  const req = new OpenAIResponsesParser().parseRequest({
    input: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'earlier answer' }] }]
  })
  assert.deepEqual(req.messages[0].content, [{ type: 'text', text: 'earlier answer' }])
})

test('flattened tools, tool_choice and sampling params are parsed', () => {
  const req = new OpenAIResponsesParser().parseRequest({
    input: 'x',
    max_output_tokens: 100,
    top_p: 0.5,
    temperature: 0.7,
    tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } }],
    tool_choice: { type: 'function', name: 'f' }
  })
  assert.deepEqual(req.tools, [{ name: 'f', description: 'd', parameters: { type: 'object' } }])
  assert.deepEqual(req.toolChoice, { name: 'f' })
  assert.equal(req.config.maxTokens, 100)
  assert.equal(req.config.topP, 0.5)
  assert.equal(req.config.temperature, 0.7)
})

console.log('openai-responses serializer (non-stream)')

test('text response produces a Responses API response object', () => {
  const out = new OpenAIResponsesSerializer().serializeResponse({
    content: [{ type: 'text', text: 'hello' }],
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5 }
  })
  assert.equal(out.object, 'response')
  assert.equal(out.status, 'completed')
  assert.match(out.id, /^resp_/)
  const msg = out.output.find((i: any) => i.type === 'message')
  assert.equal(msg.role, 'assistant')
  assert.deepEqual(msg.content, [{ type: 'output_text', text: 'hello', annotations: [], logprobs: [] }])
  assert.deepEqual(out.usage, {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 15
  })
})

test('tool calls become function_call output items', () => {
  const out = new OpenAIResponsesSerializer().serializeResponse({
    content: '',
    finishReason: 'tool_calls',
    toolCalls: [{ id: 'call_9', name: 'f', input: { a: 1 } }],
    usage: { promptTokens: 1, completionTokens: 1 }
  })
  const fc = out.output.find((i: any) => i.type === 'function_call')
  assert.equal(fc.call_id, 'call_9')
  assert.equal(fc.name, 'f')
  assert.equal(fc.arguments, '{"a":1}')
  assert.equal(fc.status, 'completed')
  // no empty message item when there is no text
  assert.equal(out.output.some((i: any) => i.type === 'message'), false)
})

test('length finish reason maps to incomplete status', () => {
  const out = new OpenAIResponsesSerializer().serializeResponse({
    content: 'partial',
    finishReason: 'length',
    usage: { promptTokens: 1, completionTokens: 1 }
  })
  assert.equal(out.status, 'incomplete')
  assert.deepEqual(out.incomplete_details, { reason: 'max_output_tokens' })
})

test('thinking content becomes a reasoning item', () => {
  const out = new OpenAIResponsesSerializer().serializeResponse({
    content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'answer' }],
    finishReason: 'stop',
    usage: { promptTokens: 1, completionTokens: 1 }
  })
  assert.deepEqual(out.output[0].summary, [{ type: 'summary_text', text: 'hmm' }])
  assert.equal(out.output[0].type, 'reasoning')
  assert.equal(out.output[1].type, 'message')
})

test('logprobs on content chunks flow into deltas and accumulate on done', () => {
  const s = new OpenAIResponsesSerializer()
  const lp1 = [{ token: 'he', logprob: -0.1, bytes: [104, 101], top_logprobs: [] }]
  const lp2 = [{ token: 'llo', logprob: -0.2, bytes: [108, 108, 111], top_logprobs: [] }]
  const events: any[] = []
  events.push(...s.serializeStreamChunk({ type: 'content', delta: 'he', logprobs: lp1 } as any))
  events.push(...s.serializeStreamChunk({ type: 'content', delta: 'llo', logprobs: lp2 } as any))
  events.push(...s.serializeStreamChunk({ type: 'done', usage: { promptTokens: 1, completionTokens: 2 } }))

  const deltas = events.filter(e => e.event === 'response.output_text.delta')
  assert.deepEqual(deltas[0].data.logprobs, lp1)
  assert.deepEqual(deltas[1].data.logprobs, lp2)

  const done = events.find(e => e.event === 'response.output_text.done')
  assert.deepEqual(done.data.logprobs, [...lp1, ...lp2])

  const completed = events[events.length - 1].data.response
  assert.deepEqual(completed.output[0].content[0].logprobs, [...lp1, ...lp2])
})

test('request parser forwards top_logprobs into config', () => {
  const req = new OpenAIResponsesParser().parseRequest({
    model: 'm', input: 'hi', top_logprobs: 5
  })
  assert.equal(req.config.topLogprobs, 5)
  assert.equal(req.config.logprobs, true)
})

console.log('openai-responses serializer (stream)')

test('full stream: text then tool call then done', () => {
  const s = new OpenAIResponsesSerializer()
  const events: any[] = []
  events.push(...s.startEvents())
  events.push(...s.serializeStreamChunk({ type: 'content', delta: 'he' }))
  events.push(...s.serializeStreamChunk({ type: 'content', delta: 'llo' }))
  events.push(...s.serializeStreamChunk({ type: 'tool_call', toolCall: { id: 'call_1', name: 'f' } }))
  events.push(...s.serializeStreamChunk({ type: 'tool_call', toolCall: { inputDelta: '{"a":' } }))
  events.push(...s.serializeStreamChunk({ type: 'tool_call', toolCall: { inputDelta: '1}' } }))
  events.push(...s.serializeStreamChunk({ type: 'done', finishReason: 'tool_calls', usage: { promptTokens: 3, completionTokens: 7 } }))

  const names = events.map(e => e.event)
  assert.deepEqual(names, [
    'response.created',
    'response.in_progress',
    'response.output_item.added',       // message
    'response.content_part.added',
    'response.output_text.delta',       // he
    'response.output_text.delta',       // llo
    'response.output_text.done',        // close message before tool call
    'response.content_part.done',
    'response.output_item.done',
    'response.output_item.added',       // function_call
    'response.function_call_arguments.delta',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.done',
    'response.output_item.done',
    'response.completed'
  ])

  // every event's data.type matches its event name and sequence numbers increase from 0
  events.forEach((e, i) => {
    assert.equal(e.data.type, e.event)
    assert.equal(e.data.sequence_number, i)
  })

  const textDone = events.find(e => e.event === 'response.output_text.done')
  assert.equal(textDone.data.text, 'hello')

  const argsDone = events.find(e => e.event === 'response.function_call_arguments.done')
  assert.equal(argsDone.data.arguments, '{"a":1}')

  const completed = events[events.length - 1].data.response
  assert.equal(completed.status, 'completed')
  assert.equal(completed.output.length, 2)
  assert.equal(completed.output[0].type, 'message')
  assert.deepEqual(completed.output[0].content, [{ type: 'output_text', text: 'hello', annotations: [], logprobs: [] }])
  assert.equal(completed.output[1].type, 'function_call')
  assert.equal(completed.output[1].call_id, 'call_1')
  assert.equal(completed.output[1].arguments, '{"a":1}')
  assert.equal(completed.usage.input_tokens, 3)
  assert.equal(completed.usage.output_tokens, 7)
  assert.equal(completed.usage.total_tokens, 10)
})

test('gemini-style complete tool call in one chunk (id + full args together)', () => {
  const s = new OpenAIResponsesSerializer()
  const events: any[] = []
  events.push(...s.startEvents())
  events.push(...s.serializeStreamChunk({ type: 'tool_call', toolCall: { id: 'c1', name: 'f', inputDelta: '{"x":1}' } }))
  events.push(...s.serializeStreamChunk({ type: 'tool_call', toolCall: { id: 'c2', name: 'g', inputDelta: '{}' } }))
  events.push(...s.serializeStreamChunk({ type: 'done', finishReason: 'tool_calls' }))

  const completed = events[events.length - 1].data.response
  assert.equal(completed.output.length, 2)
  assert.deepEqual(completed.output.map((i: any) => i.call_id), ['c1', 'c2'])
  assert.deepEqual(completed.output.map((i: any) => i.arguments), ['{"x":1}', '{}'])
  // two distinct output indexes
  const added = events.filter(e => e.event === 'response.output_item.added')
  assert.deepEqual(added.map(e => e.data.output_index), [0, 1])
})

test('thinking deltas produce a reasoning item before the message', () => {
  const s = new OpenAIResponsesSerializer()
  const events: any[] = []
  events.push(...s.startEvents())
  events.push(...s.serializeStreamChunk({ type: 'thinking', delta: 'think' }))
  events.push(...s.serializeStreamChunk({ type: 'content', delta: 'answer' }))
  events.push(...s.serializeStreamChunk({ type: 'done' }))

  const completed = events[events.length - 1].data.response
  assert.equal(completed.output[0].type, 'reasoning')
  assert.deepEqual(completed.output[0].summary, [{ type: 'summary_text', text: 'think' }])
  assert.equal(completed.output[1].type, 'message')
})

test('length finish reason emits response.incomplete', () => {
  const s = new OpenAIResponsesSerializer()
  s.startEvents()
  s.serializeStreamChunk({ type: 'content', delta: 'x' })
  const events = s.serializeStreamChunk({ type: 'done', finishReason: 'length' })
  const last = events[events.length - 1]
  assert.equal(last.event, 'response.incomplete')
  assert.equal(last.data.response.status, 'incomplete')
  assert.deepEqual(last.data.response.incomplete_details, { reason: 'max_output_tokens' })
})

console.log(`\n${passed} assertions groups passed${process.exitCode ? ', with FAILURES' : ''}`)
