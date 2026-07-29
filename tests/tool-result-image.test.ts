import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { OpenAIResponsesParser } from '../server/protocols/openai-responses.ts'
import { ClaudeMessagesParser } from '../server/protocols/claude-messages.ts'

const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) throw new Error('ADAPTER_BUILD is required')

const { OpenAIAdapter } = require(`${buildDir}/providers/openai.js`)
const { ClaudeAdapter } = require(`${buildDir}/providers/claude.js`)
const { GeminiAdapter } = require(`${buildDir}/providers/gemini.js`)
const { GeminiGenerateParser } = require(`${buildDir}/protocols/gemini-generate.js`)

const dummyConfig = {
  name: 'test',
  display_name: 'Test',
  protocol: 'openai',
  enabled: true,
  use_custom_models: false,
  connection: { api_key: 'test', base_url: 'https://example.test' },
  models: [{ id: 'model', display_name: 'Model' }]
}

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

const toolResultBlocks = [
  { type: 'text', text: 'screenshot' },
  { type: 'image', imageBase64: 'AAAA', imageMediaType: 'image/png' },
  { type: 'image', imageUrl: 'https://example.com/screenshot.jpg', imageMediaType: 'image/jpeg' }
]

console.log('multimodal tool results')

test('Responses function_call_output preserves text, URL images and data images', () => {
  const request = new OpenAIResponsesParser().parseRequest({
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'screenshot', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'screenshot' },
          { type: 'input_image', image_url: 'https://example.com/screenshot.jpg' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }
        ]
      }
    ]
  })

  assert.deepEqual(request.messages[1].content, [
    { type: 'text', text: 'screenshot' },
    { type: 'image', imageUrl: 'https://example.com/screenshot.jpg' },
    { type: 'image', imageBase64: 'AAAA', imageMediaType: 'image/png' }
  ])
})

test('Claude tool_result parser preserves nested image content', () => {
  const request = new ClaudeMessagesParser().parseRequest({
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [
          { type: 'text', text: 'screenshot' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
        ]
      }]
    }]
  })

  assert.deepEqual((request.messages[0].content as any[])[0].toolResult.content, [
    { type: 'text', text: 'screenshot' },
    { type: 'image', imageBase64: 'AAAA', imageMediaType: 'image/png' }
  ])
})

test('OpenAI Chat upstream receives the tool text before an adjacent image message', () => {
  const payload = new OpenAIAdapter(dummyConfig).toProviderRequest({
    model: 'model',
    messages: [
      { role: 'assistant', content: '', meta: { toolCalls: [{ id: 'call_1', name: 'screenshot', input: {} }] } },
      { role: 'tool', content: toolResultBlocks, meta: { toolCallId: 'call_1', name: 'screenshot' } }
    ],
    config: {}
  })

  assert.deepEqual(payload.messages[1], {
    role: 'tool',
    tool_call_id: 'call_1',
    content: 'screenshot'
  })
  assert.deepEqual(payload.messages[2], {
    role: 'user',
    content: [
      { type: 'text', text: 'Images returned by the preceding tool calls.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'image_url', image_url: { url: 'https://example.com/screenshot.jpg' } }
    ]
  })
})

test('parallel Responses image results keep all tool messages contiguous', () => {
  const request = new OpenAIResponsesParser().parseRequest({
    input: [
      { type: 'function_call', call_id: 'read_image:1', name: 'read_image', arguments: '{"path":"one.png"}' },
      { type: 'function_call', call_id: 'read_image:2', name: 'read_image', arguments: '{"path":"two.png"}' },
      {
        type: 'function_call_output',
        call_id: 'read_image:1',
        output: [
          { type: 'input_text', text: 'first image' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }
        ]
      },
      {
        type: 'function_call_output',
        call_id: 'read_image:2',
        output: [
          { type: 'input_text', text: 'second image' },
          { type: 'input_image', image_url: 'data:image/png;base64,BBBB' }
        ]
      }
    ]
  })
  const payload = new OpenAIAdapter(dummyConfig).toProviderRequest(request)

  assert.deepEqual(payload.messages.map((message: any) => message.role), [
    'assistant',
    'tool',
    'tool',
    'user'
  ])
  assert.deepEqual(payload.messages.slice(1, 3).map((message: any) => message.tool_call_id), [
    'read_image:1',
    'read_image:2'
  ])
  assert.deepEqual(payload.messages.slice(1, 3).map((message: any) => message.content), [
    'first image',
    'second image'
  ])
  assert.deepEqual(payload.messages[3].content, [
    { type: 'text', text: 'Images returned by the preceding tool calls.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }
  ])
})

test('parallel text-only results remain consecutive without an extra user message', () => {
  const request = new OpenAIResponsesParser().parseRequest({
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
      { type: 'function_call', call_id: 'call_2', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'one' },
      { type: 'function_call_output', call_id: 'call_2', output: 'two' }
    ]
  })
  const payload = new OpenAIAdapter(dummyConfig).toProviderRequest(request)

  assert.deepEqual(payload.messages.map((message: any) => message.role), ['assistant', 'tool', 'tool'])
  assert.deepEqual(payload.messages.slice(1).map((message: any) => message.tool_call_id), ['call_1', 'call_2'])
})

test('mixed text and image results flush images after every tool message', () => {
  const request = new OpenAIResponsesParser().parseRequest({
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
      { type: 'function_call', call_id: 'call_2', name: 'read_image', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'plain text' },
      {
        type: 'function_call_output',
        call_id: 'call_2',
        output: [
          { type: 'input_text', text: 'image result' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }
        ]
      }
    ]
  })
  const payload = new OpenAIAdapter(dummyConfig).toProviderRequest(request)

  assert.deepEqual(payload.messages.map((message: any) => message.role), ['assistant', 'tool', 'tool', 'user'])
  assert.deepEqual(payload.messages.slice(1, 3).map((message: any) => message.tool_call_id), ['call_1', 'call_2'])
})

test('image-only result still emits a non-empty tool message', () => {
  const request = new OpenAIResponsesParser().parseRequest({
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'read_image', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]
      }
    ]
  })
  const payload = new OpenAIAdapter(dummyConfig).toProviderRequest(request)

  assert.deepEqual(payload.messages[1], {
    role: 'tool',
    tool_call_id: 'call_1',
    content: 'Image returned by tool.'
  })
  assert.equal(payload.messages[2].role, 'user')
})

test('Claude upstream nests images inside tool_result content', () => {
  const payload = new ClaudeAdapter(dummyConfig).toProviderRequest({
    model: 'model',
    messages: [
      { role: 'assistant', content: '', meta: { toolCalls: [{ id: 'toolu_1', name: 'screenshot', input: {} }] } },
      { role: 'tool', content: toolResultBlocks, meta: { toolCallId: 'toolu_1', name: 'screenshot' } }
    ],
    config: {}
  })

  assert.deepEqual(payload.messages[1].content[0], {
    type: 'tool_result',
    tool_use_id: 'toolu_1',
    content: [
      { type: 'text', text: 'screenshot' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/screenshot.jpg' } }
    ]
  })
})

test('Gemini upstream nests inline images in functionResponse and preserves URL images', () => {
  const { payload } = new GeminiAdapter(dummyConfig).toProviderRequest({
    model: 'model',
    messages: [
      { role: 'assistant', content: '', meta: { toolCalls: [{ id: 'call_1', name: 'screenshot', input: {} }] } },
      { role: 'tool', content: toolResultBlocks, meta: { toolCallId: 'call_1', name: 'screenshot' } }
    ],
    config: {}
  })

  const resultParts = payload.contents[1].parts
  assert.deepEqual(resultParts[0].functionResponse, {
    id: 'call_1',
    name: 'screenshot',
    response: { output: 'screenshot' },
    parts: [{ inlineData: { data: 'AAAA', mimeType: 'image/png' } }]
  })
  assert.deepEqual(resultParts[1], {
    fileData: {
      fileUri: 'https://example.com/screenshot.jpg',
      mimeType: 'image/jpeg'
    }
  })
})

test('Gemini functionResponse parser preserves nested image parts', () => {
  const request = new GeminiGenerateParser().parseRequest({
    contents: [
      { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'screenshot', args: {} } }] },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            id: 'call_1',
            name: 'screenshot',
            response: { output: 'screenshot' },
            parts: [{ inlineData: { data: 'AAAA', mimeType: 'image/png' } }]
          }
        }]
      }
    ]
  })

  assert.deepEqual(request.messages[1].content, [
    { type: 'text', text: 'screenshot' },
    { type: 'image', imageBase64: 'AAAA', imageMediaType: 'image/png' }
  ])
})

console.log(`${passed} multimodal tool-result tests passed`)
