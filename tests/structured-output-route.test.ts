import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

// Execute the real route, parser, serializer and adapter conversions without
// Nuxt, provider storage, credentials or network access. Only infrastructure and
// adapter I/O are mocked; this test does not seed or read .data.
const root = fileURLToPath(new URL('../', import.meta.url))
const schema = {
  type: 'object',
  properties: { memory_ids: { type: 'array', items: { type: 'string' } } },
  required: ['memory_ids'],
  additionalProperties: false
}
const format = { type: 'json_schema', name: 'memory_selection', description: 'Selected memories', strict: true, schema }
const answer = '{"memory_ids":["memory-1"]}'
const plain = (value: any) => JSON.parse(JSON.stringify(value))

function harness(provider: 'openai' | 'openai-responses' | 'codex' | 'claude') {
  const payloads: any[] = []
  const writes: string[] = []
  const usage: any[] = []
  const timers = new Set<object>()
  let headers: any
  let flushed = false
  let syncCalls = 0
  let streamCalls = 0
  let adapter: any
  let parser: any
  const cache = new Map<string, any>()
  const forbidden = () => { throw new Error('Unexpected infrastructure/network access') }
  const mocks: Record<string, any> = {
    'server/providers/manager.ts': {
      ProviderManager: class {
        async loadProviders() {}
        getParser(url: string, method: string, body: any) {
          assert.equal(url, '/v1/responses')
          assert.equal(method, 'POST')
          assert.ok(parser.canHandle(url, method, body))
          return parser
        }
        resolveAdapter() { return { adapter, providerName: 'offline' } }
        async callLLM(request: any) {
          syncCalls++
          const payload = adapter.toProviderRequest(request)
          return adapter.fromProviderResponse(await adapter.call(payload))
        }
      }
    },
    'server/services/thinking-policy.ts': { applyThinkingPolicy: async (request: any) => request },
    'server/utils/fetch.ts': { fetchWithRetry: forbidden },
    'server/utils/codex-auth.ts': { extractChatGptAccountId: forbidden },
    'server/services/codex-token-manager.ts': { ensureCodexAccessToken: forbidden },
    'server/services/subscription-usage.ts': { consumeCodexResetCredit: forbidden }
  }
  const allowed = new Set([
    'server/api/openai/responses.post.ts',
    'server/protocols/openai-responses.ts',
    'server/protocols/openai-responses-serializer.ts',
    'server/utils/structured-output.ts',
    'server/providers/responses-codec.ts',
    'server/providers/openai.ts',
    `server/providers/${provider}.ts`
  ].map(path => resolve(root, path)))
  const globals = {
    TextDecoder, console, fetch: forbidden,
    defineEventHandler: (handler: any) => handler,
    readBody: async (event: any) => event.body,
    incrementCalls: async () => {},
    trackUsage: (_event: any, value: any) => usage.push(plain(value)),
    setResponseHeaders: (_event: any, value: any) => { headers = value },
    throwFormattedError: (error: any) => { throw error },
    formatErrorResponse: (error: any) => ({ error: { message: error.message } }),
    setInterval: () => { const timer = {}; timers.add(timer); return timer },
    clearInterval: (timer: object) => { assert.ok(timers.delete(timer)) }
  }
  function load(filename: string): any {
    filename = resolve(filename)
    const mock = mocks[filename.slice(root.length)]
    if (mock) return mock
    assert.ok(allowed.has(filename), `Unexpected module: ${filename}`)
    if (cache.has(filename)) return cache.get(filename)
    const module = { exports: {} }
    cache.set(filename, module.exports)
    const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    runInNewContext(source, {
      ...globals, module, exports: module.exports,
      require: (specifier: string) => {
        assert.ok(specifier.startsWith('.'), `Unexpected external import: ${specifier}`)
        return load(resolve(dirname(filename), specifier.endsWith('.ts') ? specifier : `${specifier}.ts`))
      }
    }, { filename })
    return module.exports
  }
  const className = { codex: 'CodexAdapter', claude: 'ClaudeAdapter', openai: 'OpenAIAdapter', 'openai-responses': 'OpenAIResponsesAdapter' }[provider]
  const Adapter = load(resolve(root, `server/providers/${provider}.ts`))[className]
  adapter = new Adapter({ name: 'offline', models: [{ id: 'test-model' }], connection: {} })
  parser = new (load(resolve(root, 'server/protocols/openai-responses.ts')).OpenAIResponsesParser)()
  const upstream = (provider === 'codex' || provider === 'openai-responses')
    ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }], usage: { input_tokens: 7, output_tokens: 3 } }
    : { choices: [{ message: { content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }
  adapter.call = async (payload: any) => { payloads.push(plain(payload)); return upstream }
  adapter.callStream = async (payload: any) => {
    streamCalls++
    payloads.push(plain(payload))
    const chunks = (provider === 'codex' || provider === 'openai-responses')
      ? [{ type: 'response.output_text.delta', delta: answer }, { type: 'response.completed', response: upstream }]
      : [{ choices: [{ delta: { content: answer } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: upstream.usage }]
    const sse = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new ReadableStream({
      start(controller) {
        // Deliberately split an SSE line across reads to exercise route buffering.
        const bytes = new TextEncoder().encode(sse)
        controller.enqueue(bytes.slice(0, 23))
        controller.enqueue(bytes.slice(23))
        controller.close()
      }
    })
  }
  const handler = load(resolve(root, 'server/api/openai/responses.post.ts')).default
  const res = {
    writableEnded: false,
    flushHeaders() { flushed = true },
    write(value: string) { writes.push(value) },
    end() { this.writableEnded = true }
  }
  return {
    payloads, writes, usage, timers, res,
    get headers() { return headers },
    get flushed() { return flushed },
    get syncCalls() { return syncCalls },
    get streamCalls() { return streamCalls },
    invoke: (stream: boolean, requestedFormat: any = format) => handler({
      body: { model: 'offline/test-model', input: 'Select memories', stream, text: { format: requestedFormat } },
      node: { res }
    })
  }
}

for (const provider of ['openai', 'openai-responses', 'codex'] as const) {
  for (const stream of [false, true]) {
    test(`actual Responses route preserves strict schema through ${provider} (stream=${stream})`, async () => {
      const h = harness(provider)
      const result = await h.invoke(stream)
      assert.equal(h.payloads.length, 1)
      const payload = h.payloads[0]
      const { type, ...json_schema } = format
      if (provider === 'codex' || provider === 'openai-responses') assert.deepEqual(payload.text.format, format)
      else assert.deepEqual(payload.response_format, { type, json_schema })
      assert.equal(payload.stream, provider === 'codex' || stream)
      assert.equal(h.syncCalls, stream ? 0 : 1)
      assert.equal(h.streamCalls, stream ? 1 : 0)
      assert.equal(h.usage.length, 1)
      assert.equal(h.usage[0].promptTokens, 7)
      assert.equal(h.usage[0].completionTokens, 3)

      let completed: any
      if (stream) {
        assert.equal(result, undefined)
        assert.equal(h.headers['Content-Type'], 'text/event-stream')
        assert.equal(h.flushed, true)
        assert.equal(h.res.writableEnded, true)
        assert.equal(h.timers.size, 0)
        const events = h.writes.map(frame => {
          const [event, data] = frame.trim().split('\n')
          const parsed = JSON.parse(data.slice('data: '.length))
          assert.equal(event, `event: ${parsed.type}`)
          return parsed
        })
        assert.equal(events.filter(event => event.type === 'response.completed').length, 1)
        for (const type of ['response.created', 'response.in_progress', 'response.completed']) {
          const event = events.find(event => event.type === type)
          assert.ok(event, `Missing ${type}`)
          assert.deepEqual(event.response.text.format, format)
        }
        assert.equal(events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta).join(''), answer)
        completed = events.find(event => event.type === 'response.completed').response
      } else {
        completed = plain(result)
        assert.equal(h.headers, undefined)
        assert.deepEqual(completed.text.format, format)
      }
      assert.equal(completed.status, 'completed')
      assert.equal(completed.output[0].content[0].text, answer)
      assert.equal(completed.usage.input_tokens, 7)
      assert.equal(completed.usage.output_tokens, 3)
    })
  }
}

for (const stream of [false, true]) {
  test(`Responses route rejects incompatible strict Claude contract before upstream (stream=${stream})`, async () => {
    const h = harness('claude')
    await assert.rejects(h.invoke(stream), (error: any) => error.statusCode === 400 && error._statusCode === 400)
    assert.deepEqual(h.payloads, [])
    assert.equal(h.streamCalls, 0)
    assert.equal(h.flushed, false)
    assert.equal(h.headers, undefined)
    assert.deepEqual(h.writes, [])
    assert.equal(h.timers.size, 0)
  })

  test(`Responses route rejects malformed schema before upstream (stream=${stream})`, async () => {
    const h = harness('openai')
    await assert.rejects(h.invoke(stream, { type: 'json_schema', name: 'invalid', strict: true }),
      (error: any) => error.statusCode === 400 && error._statusCode === 400)
    assert.deepEqual(h.payloads, [])
    assert.equal(h.syncCalls, 0)
    assert.equal(h.flushed, false)
  })
}
