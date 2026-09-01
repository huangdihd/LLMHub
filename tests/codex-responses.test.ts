import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) {
  console.error('ADAPTER_BUILD not set — run via tests/run-all.sh')
  process.exit(1)
}
const { CodexAdapter } = require(`${buildDir}/providers/codex.js`)
const { extractChatGptAccountId } = require(`${buildDir}/utils/codex-auth.js`)
const { CodexResponsesParser } = require(`${buildDir}/protocols/codex-responses.js`)
const { CodexResponsesSerializer } = require(`${buildDir}/protocols/codex-responses-serializer.js`)

let passed = 0
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(() => {
    passed++
    console.log(`  ok - ${name}`)
  }).catch((error: any) => {
    console.error(`  FAIL - ${name}`)
    console.error(error.stack || error.message)
    process.exitCode = 1
  })
}

const tokenPayload = Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct_from_jwt' }
})).toString('base64url')
const accessToken = `header.${tokenPayload}.signature`
const config = {
  name: 'codex-sub',
  protocol: 'codex-subscription',
  connection: {
    base_url: 'https://chatgpt.com/backend-api/codex',
    api_key: accessToken,
    device_id: '11111111-2222-4333-8444-555555555555',
    timeout: 1000,
    enable_timeout: true,
    max_retries: 0
  },
  models: [{ id: 'gpt-5.3-codex', display_name: 'GPT-5.3 Codex' }]
}

console.log('codex parser and serializer')

await test('Codex endpoint has a distinct parser and serializer name', () => {
  const parser = new CodexResponsesParser()
  assert.equal(parser.name, 'codex-responses')
  assert.equal(parser.canHandle('/api/codex/responses', 'POST', {}), true)
  assert.equal(parser.canHandle('/v1/responses', 'POST', {}), false)
  assert.equal(new CodexResponsesSerializer().name, 'codex-responses')
})

await test('reasoning controls and encrypted reasoning survive parsing', () => {
  const request = new CodexResponsesParser().parseRequest({
    model: 'codex-sub/gpt-5.3-codex',
    reasoning: { effort: 'high', summary: 'auto' },
    input: [{
      type: 'reasoning',
      encrypted_content: 'encrypted-state',
      summary: [{ type: 'summary_text', text: 'thought summary' }]
    }, { role: 'user', content: 'continue' }]
  })
  assert.equal(request.config.reasoningEffort, 'high')
  assert.equal(request.config.reasoningSummary, 'auto')
  assert.deepEqual(request.messages[0].content, [
    { type: 'thinking', thinking: 'thought summary' },
    { type: 'redacted_thinking', signature: 'encrypted-state' }
  ])
})

await test('encrypted reasoning survives non-stream and stream serialization', () => {
  const sync = new CodexResponsesSerializer().serializeResponse({
    content: [
      { type: 'thinking', thinking: 'summary' },
      { type: 'redacted_thinking', signature: 'encrypted-state' },
      { type: 'text', text: 'answer' }
    ],
    finishReason: 'stop',
    usage: { promptTokens: 1, completionTokens: 1 }
  })
  assert.equal(sync.output[0].type, 'reasoning')
  assert.equal(sync.output[0].encrypted_content, 'encrypted-state')

  const stream = new CodexResponsesSerializer()
  stream.serializeStreamChunk({ type: 'thinking', delta: 'summary' })
  stream.serializeStreamChunk({ type: 'thinking', encryptedContent: 'encrypted-state' })
  const terminal = stream.serializeStreamChunk({ type: 'done' })
  const completed = terminal.find((event: any) => event.event === 'response.completed')
  assert.equal(completed.data.response.output[0].encrypted_content, 'encrypted-state')
})

await test('provider failures serialize as response.failed', () => {
  const sync = new CodexResponsesSerializer().serializeResponse({
    content: '',
    finishReason: 'error',
    usage: { promptTokens: 0, completionTokens: 0 }
  })
  assert.equal(sync.status, 'failed')
  assert.equal(sync.error.code, 'provider_error')

  const events = new CodexResponsesSerializer().serializeStreamChunk({
    type: 'done', finishReason: 'error'
  })
  assert.equal(events.at(-1).event, 'response.failed')
  assert.equal(events.at(-1).data.response.status, 'failed')
})

console.log('codex adapter')

await test('provider request uses Responses shape and injects device_id into client_metadata', () => {
  const adapter = new CodexAdapter(config)
  const payload = adapter.toProviderRequest({
    model: 'codex-sub/gpt-5.3-codex',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '', meta: { toolCalls: [{ id: 'call_1', name: 'shell', input: { cmd: 'pwd' } }] } },
      { role: 'tool', content: '/tmp', meta: { toolCallId: 'call_1', name: 'shell' } }
    ],
    config: { systemPrompt: 'be concise', reasoningEffort: 'high' },
    tools: [{ name: 'shell', description: 'run command', parameters: { type: 'object' } }],
    toolChoice: 'auto',
    stream: false
  })

  assert.equal(payload.model, 'gpt-5.3-codex')
  assert.equal(payload.stream, true)
  assert.equal(payload.store, false)
  assert.equal(payload.client_metadata['x-codex-installation-id'], config.connection.device_id)
  assert.equal(payload.input[0].content[0].type, 'input_text')
  assert.equal(payload.input[1].type, 'function_call')
  assert.equal(payload.input[2].type, 'function_call_output')
  assert.equal(payload.tools[0].name, 'shell')
  assert.equal(payload.tools[0].strict, false)
  assert.deepEqual(payload.reasoning, { effort: 'high', summary: 'auto' })
})

await test('account id is extracted from the Codex access-token JWT', () => {
  assert.equal(extractChatGptAccountId(accessToken), 'acct_from_jwt')
  assert.equal(extractChatGptAccountId('opaque-token'), undefined)
})

await test('sync call sends Codex auth headers and collects terminal SSE response', async () => {
  const originalFetch = globalThis.fetch
  let captured: any
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = { url, init, body: JSON.parse(String(init.body)) }
    const completed = {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [{
          type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'hello back' }]
        }],
        usage: { input_tokens: 4, output_tokens: 2 }
      }
    }
    return new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  }) as any

  try {
    const adapter = new CodexAdapter(config)
    const response = await adapter.call({ model: 'gpt-5.3-codex', input: [] })
    assert.equal(captured.url, 'https://chatgpt.com/backend-api/codex/responses')
    assert.equal(captured.init.headers['x-codex-installation-id'], config.connection.device_id)
    assert.equal(captured.init.headers['ChatGPT-Account-Id'], 'acct_from_jwt')
    assert.equal(captured.body.stream, true)
    assert.equal(captured.body.store, false)
    assert.equal(response.id, 'resp_1')
    assert.deepEqual(adapter.fromProviderResponse(response), {
      content: [{ type: 'text', text: 'hello back' }],
      finishReason: 'stop',
      usage: { promptTokens: 4, completionTokens: 2 }
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('stream events normalize text, reasoning, tool calls and usage', () => {
  const adapter = new CodexAdapter(config)
  const state = {}
  assert.deepEqual(adapter.fromProviderStreamChunk({ type: 'response.output_text.delta', delta: 'hi' }, state), {
    type: 'content', delta: 'hi'
  })
  assert.deepEqual(adapter.fromProviderStreamChunk({ type: 'response.reasoning_summary_text.delta', delta: 'think' }, state), {
    type: 'thinking', delta: 'think'
  })
  assert.deepEqual(adapter.fromProviderStreamChunk({
    type: 'response.output_item.added', output_index: 1,
    item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell' }
  }, state), {
    type: 'tool_call', toolCall: { index: 1, id: 'call_1', name: 'shell' }
  })
  assert.deepEqual(adapter.fromProviderStreamChunk({
    type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"cmd":"pwd"}'
  }, state), {
    type: 'tool_call', toolCall: { index: 1, inputDelta: '{"cmd":"pwd"}' }
  })
  assert.deepEqual(adapter.fromProviderStreamChunk({
    type: 'response.completed',
    response: {
      status: 'completed',
      output: [{ type: 'function_call' }],
      usage: { input_tokens: 7, output_tokens: 3 }
    }
  }, state), {
    type: 'done', finishReason: 'tool_calls', usage: { promptTokens: 7, completionTokens: 3 }
  })
})

console.log(`\n${passed} Codex test groups passed${process.exitCode ? ', with FAILURES' : ''}`)
