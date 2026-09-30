import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { OpenAIResponsesSerializer } from '../server/protocols/openai-responses-serializer.ts'
import type { LLMStreamChunk } from '../server/core/types.ts'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('ADAPTER_BUILD not set — run via tests/run-all.sh')
const { ResponsesCodec } = require(`${build}/providers/responses-codec.js`)
const { OpenAIResponsesAdapter } = require(`${build}/providers/openai-responses.js`)
const { OpenAIAdapter } = require(`${build}/providers/openai.js`)
const configuration = { name: 'reasoning-test', connection: {}, models: [{ id: 'test-model' }] }
let passed = 0
async function test(name: string, run: () => unknown | Promise<unknown>) {
  try { await run(); passed++; console.log(`  ok - ${name}`) }
  catch (error) { console.error(`  FAIL - ${name}`, error); process.exitCode = 1 }
}

function normalize(events: any[], codec = new ResponsesCodec(configuration)): LLMStreamChunk[] {
  const state = {}
  return events.flatMap(event => codec.fromProviderStreamChunk(event, state) || [])
}
function reasoningText(output: any[], kind: 'raw' | 'summary'): string {
  return output.filter(item => item.type === 'reasoning')
    .flatMap(item => kind === 'raw' ? item.content || [] : item.summary || [])
    .filter(part => part.type === (kind === 'raw' ? 'reasoning_text' : 'summary_text'))
    .map(part => part.text).join('')
}
function serialize(chunks: LLMStreamChunk[]) {
  const serializer = new OpenAIResponsesSerializer()
  return [...serializer.startEvents(), ...chunks.flatMap(chunk => serializer.serializeStreamChunk(chunk))]
}
const mixedEvents = [
  { type: 'response.reasoning_text.delta', item_id: 'reasoning-a', content_index: 0, delta: '原始 ' },
  { type: 'response.reasoning_summary_text.delta', item_id: 'reasoning-a', summary_index: 0, delta: 'Summary ' },
  { type: 'response.reasoning_text.delta', item_id: 'reasoning-a', content_index: 0, delta: 'reasoning' },
  { type: 'response.reasoning_summary_text.delta', item_id: 'reasoning-a', summary_index: 0, delta: 'only' },
  { type: 'response.reasoning_text.done', item_id: 'reasoning-a', content_index: 0, text: '原始 reasoning' },
  { type: 'response.reasoning_summary_text.done', item_id: 'reasoning-a', summary_index: 0, text: 'Summary only' },
  { type: 'response.output_text.delta', item_id: 'message-a', content_index: 0, delta: 'Answer' },
  { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 8 } } }
]

await test('codec keeps interleaved raw reasoning and summary explicitly separate without done duplication', () => {
  const chunks = normalize(mixedEvents)
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'thinking'), [
    { type: 'thinking', delta: '原始 ', reasoningKind: 'raw' },
    { type: 'thinking', delta: 'Summary ', reasoningKind: 'summary' },
    { type: 'thinking', delta: 'reasoning', reasoningKind: 'raw' },
    { type: 'thinking', delta: 'only', reasoningKind: 'summary' }
  ])
  assert.deepEqual(chunks.at(-1), { type: 'done', finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 8 } })
})

await test('raw done fallback is scoped to both item_id and content_index', () => {
  const chunks = normalize([
    { type: 'response.reasoning_text.delta', item_id: 'a', content_index: 0, delta: 'streamed' },
    { type: 'response.reasoning_text.done', item_id: 'a', content_index: 0, text: 'streamed' },
    { type: 'response.reasoning_text.done', item_id: 'a', content_index: 1, text: 'second part' },
    { type: 'response.reasoning_text.done', item_id: 'b', content_index: 0, text: 'second item' }
  ])
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'thinking'), [
    { type: 'thinking', delta: 'streamed', reasoningKind: 'raw' },
    { type: 'thinking', delta: 'second part', reasoningKind: 'raw' },
    { type: 'thinking', delta: 'second item', reasoningKind: 'raw' }
  ])
  assert.deepEqual(normalize([{ type: 'response.reasoning_text.done', item_id: 'a', content_index: 0, text: 'fresh stream' }])
    .filter(chunk => chunk.type === 'thinking'), [{ type: 'thinking', delta: 'fresh stream', reasoningKind: 'raw' }])
})

await test('nonstream codec and serializer preserve both channels and encrypted reasoning', () => {
  const codec = new ResponsesCodec(configuration)
  const normalized = codec.fromProviderResponse({ status: 'completed', output: [
    { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Raw first. ' }, { type: 'reasoning_text', text: 'Raw second.' }], summary: [{ type: 'summary_text', text: 'Summary.' }], encrypted_content: 'test-opaque' },
    { type: 'message', content: [{ type: 'output_text', text: 'Answer' }] }
  ] })
  const thinking = normalized.content.filter((block: any) => block.type === 'thinking')
  assert.equal(thinking.filter((block: any) => block.reasoningKind === 'raw').map((block: any) => block.thinking).join(''), 'Raw first. Raw second.')
  assert.equal(thinking.filter((block: any) => block.reasoningKind === 'summary').map((block: any) => block.thinking).join(''), 'Summary.')
  assert.equal(thinking.every((block: any) => ['raw', 'summary'].includes(block.reasoningKind)), true)
  const result = new OpenAIResponsesSerializer().serializeResponse(normalized)
  assert.equal(reasoningText(result.output, 'raw'), 'Raw first. Raw second.')
  assert.equal(reasoningText(result.output, 'summary'), 'Summary.')
  assert.equal(result.output.find((item: any) => item.encrypted_content)?.encrypted_content, 'test-opaque')
  assert.equal(result.output.find((item: any) => item.type === 'message').content[0].text, 'Answer')
})

await test('serializer emits raw lifecycle and summary lifecycle separately when interleaved', () => {
  const events = serialize([
    { type: 'thinking', delta: 'raw one ', reasoningKind: 'raw' },
    { type: 'thinking', delta: 'summary ', reasoningKind: 'summary' },
    { type: 'thinking', delta: 'raw two', reasoningKind: 'raw' },
    { type: 'thinking', delta: 'end', reasoningKind: 'summary' },
    { type: 'done', finishReason: 'stop' }
  ])
  assert.equal(events.filter(event => event.event === 'response.reasoning_text.delta').map(event => event.data.delta).join(''), 'raw one raw two')
  assert.equal(events.filter(event => event.event === 'response.reasoning_text.done').map(event => event.data.text).join(''), 'raw one raw two')
  assert.equal(events.filter(event => event.event === 'response.reasoning_summary_text.delta').map(event => event.data.delta).join(''), 'summary end')
  assert.equal(events.filter(event => event.event === 'response.reasoning_summary_text.done').map(event => event.data.text).join(''), 'summary end')
  const rawParts = events.filter(event => event.event === 'response.content_part.done' && event.data.part.type === 'reasoning_text')
  assert.equal(rawParts.map(event => event.data.part.text).join(''), 'raw one raw two')
  for (const event of events.filter(event => event.event === 'response.reasoning_text.delta')) {
    assert.equal(typeof event.data.item_id, 'string')
    assert.equal(typeof event.data.content_index, 'number')
    assert.equal(typeof event.data.output_index, 'number')
  }
  assert.deepEqual(events.map(event => event.data.sequence_number), events.map((_, index) => index))
  const final = events.at(-1)!.data.response
  assert.equal(reasoningText(final.output, 'raw'), 'raw one raw two')
  assert.equal(reasoningText(final.output, 'summary'), 'summary end')
})

await test('legacy untagged thinking remains summary for streaming and nonstream output', () => {
  const events = serialize([{ type: 'thinking', delta: 'Legacy' }, { type: 'done', finishReason: 'stop' }])
  assert.equal(events.some(event => event.event.startsWith('response.reasoning_text.')), false)
  assert.equal(events.find(event => event.event === 'response.reasoning_summary_text.delta')?.data.delta, 'Legacy')
  assert.equal(reasoningText(events.at(-1)!.data.response.output, 'summary'), 'Legacy')
  const result = new OpenAIResponsesSerializer().serializeResponse({ content: [{ type: 'thinking', thinking: 'Legacy' }], finishReason: 'stop' })
  assert.equal(reasoningText(result.output, 'summary'), 'Legacy')
  assert.equal(reasoningText(result.output, 'raw'), '')
})

await test('unknown reasoning events warn once in a stream and again in a new stream', () => {
  const codec = new ResponsesCodec(configuration)
  const originalWarn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...arguments_: unknown[]) => { warnings.push(arguments_) }
  try {
    const state = {}
    const event = { type: 'response.reasoning_future.delta', delta: 'Do not reinterpret' }
    for (let index = 0; index < 3; index++) {
      const chunks = [codec.fromProviderStreamChunk(event, state)].flat()
      assert.equal(chunks.some(chunk => chunk?.delta), false)
    }
    assert.equal(warnings.length, 1)
    codec.fromProviderStreamChunk(event, {})
    assert.equal(warnings.length, 2)
  } finally { console.warn = originalWarn }
})

await test('reasoning channel metadata does not alter existing request serialization', () => {
  const codec = new ResponsesCodec(configuration)
  function request(reasoningKind?: 'raw' | 'summary') {
    return codec.toProviderRequest({ model: 'api/test-model', stream: true,
      messages: [{ role: 'user', content: 'Question' }, { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Reasoning', ...(reasoningKind ? { reasoningKind } : {}) },
        { type: 'redacted_thinking', reasoningProvider: 'openai', data: 'test-opaque' },
        { type: 'text', text: 'Answer' }
      ] }], config: { thinking: { effort: 'high', includeSummary: false }, maxTokens: 32 }
    })
  }
  const legacy = request()
  assert.deepEqual(request('raw'), legacy)
  assert.deepEqual(request('summary'), legacy)
  assert.deepEqual(legacy.reasoning, { effort: 'high' })
  assert.deepEqual(legacy.include, ['reasoning.encrypted_content'])
  assert.deepEqual(legacy.input[1], { type: 'reasoning', encrypted_content: 'test-opaque', summary: [{ type: 'summary_text', text: 'Reasoning' }] })
  assert.equal(legacy.max_output_tokens, 32)
})

await test('real local HTTP transport preserves raw Responses reasoning; Chat reasoning stays legacy summary', async () => {
  const requests: { path: string; body: any }[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    requests.push({ path: request.url || '', body: JSON.parse(body) })
    const events = request.url === '/responses' ? mixedEvents : [
      { choices: [{ delta: { reasoning_content: 'Chat reasoning' } }] },
      { choices: [{ delta: { content: 'Chat answer' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]
    response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
    const bytes = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + (request.url === '/responses' ? '' : 'data: [DONE]\n\n'))
    // Split UTF-8 and SSE records independently of protocol boundaries.
    for (let index = 0; index < bytes.length; index += 7) response.write(bytes.subarray(index, index + 7))
    response.end()
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const localConfiguration = { ...configuration, connection: { base_url: `http://127.0.0.1:${address.port}`, api_key: 'local-test-only', timeout: 2000, enable_timeout: true, max_retries: 0 } }
    for (const [Adapter, expectedPath, expectedRaw, expectedSummary] of [
      [OpenAIResponsesAdapter, '/responses', '原始 reasoning', 'Summary only'],
      [OpenAIAdapter, '/chat/completions', '', 'Chat reasoning']
    ] as const) {
      const adapter = new Adapter(localConfiguration)
      const payload = adapter.toProviderRequest({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'Question' }], config: {} })
      const wire = await new Response(await adapter.callStream(payload)).text()
      const upstream = wire.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim()).filter(data => data && data !== '[DONE]').map(data => JSON.parse(data))
      const chunks = normalize(upstream, adapter)
      if (expectedPath === '/chat/completions') {
        assert.ok(chunks.some(chunk => chunk.type === 'thinking' && chunk.delta === 'Chat reasoning'))
        assert.equal(chunks.some(chunk => chunk.reasoningKind === 'raw'), false)
      }
      const events = serialize(chunks)
      const final = events.find(event => event.event === 'response.completed')?.data.response
      assert.ok(final, 'transport must reach successful terminal response')
      assert.equal(reasoningText(final.output, 'raw'), expectedRaw)
      assert.equal(reasoningText(final.output, 'summary'), expectedSummary)
      assert.equal(requests.at(-1)!.path, expectedPath)
      assert.equal(requests.at(-1)!.body.stream, true)
    }
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

console.log(`\n${passed} responses reasoning tests passed`)
