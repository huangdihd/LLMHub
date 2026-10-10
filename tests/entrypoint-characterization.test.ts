import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

// Keep the real route, pipeline and wire codecs; replace only provider I/O,
// accounting persistence, Nitro globals and the clock. No credentials or network.
const root = fileURLToPath(new URL('../', import.meta.url))
const definitions = {
  'openai-completion': ['builtin/ingress-openai/server/api/openai/completions.post.ts', 'OpenAICompletion'],
  'claude-completion': ['builtin/ingress-claude/server/api/claude/v1/complete.post.ts', 'ClaudeCompletion'],
  'openai-chat': ['builtin/ingress-openai/server/api/openai/chat/completions.post.ts', 'OpenAIChat'],
  'openai-responses': ['builtin/ingress-openai/server/api/openai/responses.post.ts', 'OpenAIResponses'],
  'claude-messages': ['builtin/ingress-claude/server/api/claude/v1/messages.post.ts', 'ClaudeMessages'],
  'gemini-generate': ['builtin/ingress-gemini/server/api/gemini/[version]/[...].ts', 'GeminiGenerate']
} as const
type Protocol = keyof typeof definitions
type Failure = 'call' | 'open' | 'read'
const usage = { promptTokens: 7, completionTokens: 3, totalTokens: 10 }
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))

type HarnessOptions = {
  stream?: boolean
  failure?: Failure
  array?: boolean
  malformed?: boolean
  embedding?: 'openai' | 'embedContent' | 'batchEmbedContents'
  body?: unknown
  rawPath?: string
  method?: string
  resolvedModel?: string
  parseFailure?: boolean
}

function harness(protocol: Protocol, options: HarnessOptions = {}) {
  const writes: string[] = []
  const completions: any[] = []
  const completionProtocols: string[] = []
  const errors: unknown[] = []
  const requests: any[] = []
  const timers = new Set<() => void>()
  const callbacks: Array<() => void> = []
  const failure = Object.assign(new Error('upstream unavailable'), { _providerError: true, statusCode: 502 })
  let headers: Record<string, string> = {}
  let endCount = 0
  const response = {
    headersSent: false, writableEnded: false,
    flushHeaders() { this.headersSent = true },
    write(value: string) { assert.equal(this.writableEnded, false); writes.push(value) },
    end() { this.writableEnded = true; endCount++ }
  }
  const forbidden = () => { throw new Error('Unexpected external I/O') }
  const globals = {
    Buffer, TextDecoder, TextEncoder, ReadableStream, Error,
    console: { log() {}, error() {} }, fetch: forbidden,
    defineEventHandler: (handler: unknown) => handler,
    readBody: async (event: any) => {
      if (options.parseFailure) throw new Error('invalid JSON')
      return event.body
    },
    getQuery: () => options.array ? {} : { alt: 'sse' },
    createError: (details: any) => Object.assign(new Error(details.message || details.statusMessage), details),
    throwFormattedError: (error: unknown) => { throw error },
    formatErrorResponse: (error: any) => ({ error: { message: error.message, code: null } }),
    setResponseHeaders: (_event: unknown, value: Record<string, string>) => { headers = value },
    setResponseStatus: () => {},
    setInterval: (callback: () => void, milliseconds: number) => {
      assert.equal(milliseconds, 15000)
      timers.add(callback)
      callbacks.push(callback)
      return callback
    },
    clearInterval: (callback: () => void) => { assert.ok(timers.delete(callback)) }
  }
  const cache = new Map<string, any>()
  const adapter = {
    name: 'offline',
    toProviderRequest(request: any) { requests.push(plain(request)); return request },
    fromProviderStreamChunk(chunk: any) { return chunk },
    async callStream() {
      if (options.failure === 'open') throw failure
      let index = 0
      const chunks = [
        ...(options.malformed ? ['data: {invalid}\n\n'] : []),
        `data: ${JSON.stringify({ type: 'content', delta: 'Hello' })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', finishReason: 'stop', usage })}\n\n`,
        'data: [DONE]\n\n'
      ]
      return { getReader: () => ({ async read() {
        for (const callback of timers) callback()
        if (options.failure === 'read' && index === 1) throw failure
        if (index === chunks.length) return { done: true }
        return { done: false, value: new TextEncoder().encode(chunks[index++]) }
      } }) }
    }
  }
  class ProviderManager {
    async loadProviders() {}
    getParser() { return new (load(`builtin/ingress-${protocol.split('-')[0]}/${protocol}.ts`)[`${definitions[protocol][1]}Parser`])() }
    getSerializer() { return new (load(`builtin/ingress-${protocol.split('-')[0]}/${protocol}-serializer.ts`)[`${definitions[protocol][1]}Serializer`])() }
    resolveAdapter() { return { adapter, providerName: 'offline' } }
    getProviderConfig() { return undefined }
    buildGatewayError(message: string, statusCode: number) { return Object.assign(new Error(message), { statusCode }) }
    async embed(request: any) {
      requests.push(plain(request))
      if (options.failure === 'call') throw failure
      return { model: 'offline/returned-model', embeddings: request.input.map(() => [0.5, -0.25]), usage }
    }
    async callLLM(request: any) {
      requests.push(plain(request))
      if (options.failure === 'call') throw failure
      return { id: 'answer-1', model: 'offline/model', content: [{ type: 'text', text: 'Hello' }], finishReason: 'stop', usage }
    }
  }
  function load(path: string): any {
    const filename = resolve(root, path)
    if (filename === resolve(root, 'server/providers/manager.ts')) return { ProviderManager }
    if (cache.has(filename)) return cache.get(filename)
    assert.ok(filename.startsWith(resolve(root, 'server') + '/') || filename.startsWith(resolve(root, 'builtin') + '/'), filename)
    const module = { exports: {} }
    cache.set(filename, module.exports)
    const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    runInNewContext(source, {
      ...globals, module, exports: module.exports,
      require: (specifier: string) => {
        assert.ok(specifier.startsWith('.'), `Unexpected external import ${specifier}`)
        return load(resolve(dirname(filename), specifier.endsWith('.ts') ? specifier : `${specifier}.ts`))
      }
    }, { filename })
    return module.exports
  }
  load('server/core/hooks.ts').requestHooks.register({
    id: 'characterization',
    onError: (error: unknown) => { errors.push(error) },
    onComplete: (completion: unknown, context: { incomingProtocol: string }) => {
      completions.push(completion)
      completionProtocols.push(context.incomingProtocol)
    }
  })
  const handler = load(options.embedding === 'openai' ? 'builtin/ingress-openai/server/api/openai/embeddings.post.ts' : definitions[protocol][0]).default
  const event = {
    method: 'POST', node: { res: response },
    context: { params: { _: `models/offline%2Fmodel:${options.stream ? 'streamGenerateContent' : 'generateContent'}` } },
    body: { model: 'offline/model', stream: !!options.stream, max_tokens: 32, prompt: '\n\nHuman: Hi\n\nAssistant:',
      messages: [{ role: 'user', content: 'Hi' }], input: 'Hi', contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] }
  }
  if (options.embedding && options.embedding !== 'openai') event.context.params._ = `models/offline%2Fmodel:${options.embedding}`
  if (options.rawPath !== undefined) event.context.params._ = options.rawPath
  if (options.method !== undefined) event.method = options.method
  if (options.resolvedModel !== undefined) Object.assign(event.context, { _resolvedModel: options.resolvedModel })
  if (Object.hasOwn(options, 'body')) Object.assign(event, { body: options.body })
  return { invoke: () => handler(event), writes, completions, completionProtocols, errors, requests, timers, response, failure,
    get headers() { return headers }, get endCount() { return endCount },
    tickAfterEnd() { for (const callback of callbacks) callback() } }
}

for (const protocol of Object.keys(definitions) as Protocol[]) {
  test(`${protocol} entry: nonstream wire response and accounting`, async () => {
    const h = harness(protocol)
    const result = plain(await h.invoke())
    const texts: Record<Protocol, () => string> = {
      'openai-chat': () => result.choices[0].message.content,
      'openai-completion': () => result.choices[0].text,
      'openai-responses': () => result.output.find((item: any) => item.type === 'message').content[0].text,
      'claude-messages': () => result.content[0].text,
      'claude-completion': () => result.completion,
      'gemini-generate': () => result.candidates[0].content.parts[0].text
    }
    assert.equal(texts[protocol](), 'Hello')
    assert.equal(h.requests[0].model, 'offline/model')
    assert.deepEqual(plain(h.completions), [{ usage, model: 'offline/model' }])
    assert.equal(h.completions.length, 1)
    assert.equal(h.errors.length, 0)
    assert.equal(h.response.headersSent, false)
    assert.equal(h.timers.size, 0)
  })

  test(`${protocol} entry: SSE framing, terminal event, keepalive and cleanup`, async () => {
    const h = harness(protocol, { stream: true })
    await h.invoke()
    assert.deepEqual(plain(h.headers), { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    const wire = h.writes.join('')
    assert.ok(wire.includes('Hello'))
    assert.ok(wire.includes(protocol.startsWith('claude-') ? 'event: ping\ndata: {"type":"ping"}\n\n' : ': ping\n\n'))
    const terminals: Record<Protocol, string> = {
      'openai-chat': 'data: [DONE]',
      'openai-completion': 'data: [DONE]',
      'openai-responses': 'event: response.completed',
      'claude-messages': 'event: message_stop',
      'claude-completion': '"stop_reason":"stop_sequence"',
      'gemini-generate': '"finishReason":"STOP"'
    }
    assert.equal(wire.split(terminals[protocol]).length - 1, 1)
    assert.equal(h.endCount, 1)
    assert.equal(h.timers.size, 0)
    assert.equal(h.completions.length, 1)
    const count = h.writes.length
    h.tickAfterEnd()
    assert.equal(h.writes.length, count)
    assert.deepEqual(plain(h.completions), [{ usage, model: 'offline/model' }])
  })

  for (const failure of ['call', 'open'] as const) {
    test(`${protocol} entry: ${failure} failure remains outside SSE`, async () => {
      const h = harness(protocol, { failure, stream: failure === 'open' })
      await assert.rejects(h.invoke(), error => error === h.failure)
      assert.equal(h.response.headersSent, false)
      assert.deepEqual(h.writes, [])
      assert.equal(h.timers.size, 0)
      assert.deepEqual(h.errors, [h.failure])
      assert.equal(h.completions.length, 1)
      assert.equal(h.completions[0].error, h.failure)
      assert.equal(h.completions[0].model, 'offline/model')
      assert.equal(h.completions[0].usage, undefined)
    })
  }

  test(`${protocol} entry: reader failure emits protocol error after headers and closes`, async () => {
    const h = harness(protocol, { stream: true, failure: 'read' })
    await h.invoke()
    assert.equal(h.response.headersSent, true)
    assert.ok(h.writes.join('').includes('upstream unavailable'))
    assert.ok(h.writes.join('').includes(protocol.startsWith('claude-') || protocol === 'openai-responses' ? 'event: error' : '"error"'))
    assert.equal(h.endCount, 1)
    assert.equal(h.timers.size, 0)
    assert.deepEqual(h.errors, [h.failure])
    assert.equal(h.completions.length, 1)
    assert.equal(h.completions[0].model, 'offline/model')
    assert.equal(h.completions[0].usage, undefined)
    assert.equal(h.completions[0].error, h.failure)
  })

  test(`${protocol} entry: malformed upstream frame is dropped, later content survives`, async () => {
    const h = harness(protocol, { stream: true, malformed: true })
    await h.invoke()
    assert.ok(h.writes.join('').includes('Hello'))
    assert.equal(h.errors.length, 1)
    assert.equal(h.endCount, 1)
    assert.equal(h.timers.size, 0)
  })
}

test('Gemini entry: default streaming transport is a JSON array without SSE or keepalive', async () => {
  const h = harness('gemini-generate', { stream: true, array: true })
  const result = plain(await h.invoke())
  assert.ok(Array.isArray(result))
  assert.equal(result[0].candidates[0].content.parts[0].text, 'Hello')
  assert.equal(result.at(-1).candidates[0].finishReason, 'STOP')
  assert.deepEqual(h.writes, [])
  assert.equal(h.response.headersSent, false)
  assert.equal(h.endCount, 0)
  assert.equal(h.timers.size, 0)
})

for (const input of ['hello', ['hello', 'world'], [1, 2], [[1, 2], [3]]]) {
  test(`OpenAI embeddings entry: normalizes ${JSON.stringify(input)} and accounts usage`, async () => {
    const h = harness('openai-chat', { embedding: 'openai', body: { model: 'offline/model', input, dimensions: 2 } })
    const result = plain(await h.invoke())
    const normalized = typeof input === 'string' || typeof input[0] === 'number' ? [input] : input
    assert.deepEqual(h.requests, [{ model: 'offline/model', input: normalized, dimensions: 2, encodingFormat: 'float' }])
    assert.deepEqual(result, {
      object: 'list', model: 'offline/returned-model',
      data: normalized.map((_, index) => ({ object: 'embedding', index, embedding: [0.5, -0.25] })),
      usage: { prompt_tokens: 7, total_tokens: 10 }
    })
    assert.deepEqual(plain(h.completions), [
      { usage: { promptTokens: 10, completionTokens: 0 }, model: 'offline/returned-model' }
    ])
    assert.deepEqual(h.completionProtocols, ['openai-embedding'])
    assert.deepEqual(h.writes, [])
    assert.equal(h.timers.size, 0)
  })
}

test('OpenAI embeddings entry: base64 encodes little-endian float32 values', async () => {
  const h = harness('openai-chat', { embedding: 'openai', body: { model: 'offline/model', input: 'hello', encoding_format: 'base64' } })
  const result = plain(await h.invoke())
  const bytes = Buffer.from(result.data[0].embedding, 'base64')
  assert.equal(bytes.length, 8)
  assert.equal(bytes.readFloatLE(0), 0.5)
  assert.equal(bytes.readFloatLE(4), -0.25)
})

for (const body of [undefined, {}, { input: null }, { input: [] }]) {
  test(`OpenAI embeddings entry: rejects missing or empty input ${JSON.stringify(body)}`, async () => {
    const h = harness('openai-chat', { embedding: 'openai', body })
    await assert.rejects(h.invoke(), (error: any) => error.statusCode === 400)
    assert.deepEqual(h.requests, [])
    assert.equal(h.completions.length, 1)
    assert.equal(h.completions[0].usage, undefined)
    assert.equal(h.completions[0].model, undefined)
    assert.equal(h.completions[0].error.statusCode, 400)
  })
}

for (const action of ['embedContent', 'batchEmbedContents'] as const) {
  for (const separator of [':', '/']) {
    test(`Gemini embeddings entry: ${action} accepts ${separator} and resolved model`, async () => {
      const item = { content: { parts: [{ text: 'hello' }, { inlineData: {} }, { text: ' world' }] },
        outputDimensionality: 2, taskType: 'RETRIEVAL_DOCUMENT', title: 'Document' }
      const body = action === 'embedContent' ? item : { requests: [item, { content: 'second', outputDimensionality: 99 }] }
      const h = harness('gemini-generate', { embedding: action, body, resolvedModel: 'fallback/chosen',
        rawPath: `models/offline%2Fmodel${separator}${action}` })
      const result = plain(await h.invoke())
      assert.deepEqual(h.requests, [{ model: 'fallback/chosen', input: action === 'embedContent' ? ['hello world'] : ['hello world', 'second'],
        dimensions: 2, taskType: 'RETRIEVAL_DOCUMENT', title: 'Document' }])
      assert.deepEqual(result, action === 'embedContent' ? { embedding: { values: [0.5, -0.25] } } :
        { embeddings: [{ values: [0.5, -0.25] }, { values: [0.5, -0.25] }] })
      assert.deepEqual(plain(h.completions), [
        { usage: { promptTokens: 10, completionTokens: 0 }, model: 'offline/returned-model' }
      ])
      assert.deepEqual(h.completionProtocols, ['gemini-embedding'])
    })
  }
}

for (const embedding of ['openai', 'embedContent', 'batchEmbedContents'] as const) {
  test(`${embedding} embeddings entry: provider failure completes once without usage`, async () => {
    const h = harness('gemini-generate', { embedding, failure: 'call', body: {
      model: 'offline/model', input: 'hello', content: 'hello', requests: [{ content: 'hello' }]
    } })
    await assert.rejects(h.invoke(), error => error === h.failure)
    assert.equal(h.completions.length, 1)
    assert.equal(h.completions[0].model, 'offline/model')
    assert.equal(h.completions[0].usage, undefined)
    assert.equal(h.completions[0].error, h.failure)
    assert.equal(h.response.headersSent, false)
    assert.deepEqual(h.writes, [])
  })
}

test('Gemini embeddings entry: empty batch completes without provider usage', async () => {
  const h = harness('gemini-generate', { embedding: 'batchEmbedContents', body: { requests: [] } })
  await assert.rejects(h.invoke(), (error: any) => error.statusCode === 400 && error.message === 'No content provided to embed')
  assert.deepEqual(h.requests, [])
  assert.equal(h.completions.length, 1)
  assert.equal(h.completions[0].usage, undefined)
  assert.equal(h.completions[0].model, undefined)
  assert.equal(h.completions[0].error.statusCode, 400)
})

test('Gemini embeddings entry: malformed JSON becomes a 400 parse error', async () => {
  const h = harness('gemini-generate', { embedding: 'embedContent', parseFailure: true })
  await assert.rejects(h.invoke(), (error: any) => error.statusCode === 400 && error.message === 'Parse error: invalid JSON')
  assert.deepEqual(h.requests, [])
  assert.equal(h.completions.length, 1)
  assert.equal(h.completions[0].usage, undefined)
  assert.equal(h.completions[0].model, undefined)
  assert.equal(h.completions[0].error.statusCode, 400)
})

for (const options of [{ method: 'GET' }, { rawPath: 'models/offline%2Fmodel:countTokens' }, { rawPath: 'models/:generateContent' }]) {
  test(`Gemini entry: rejects unsupported method/action ${JSON.stringify(options)}`, async () => {
    const h = harness('gemini-generate', options)
    await assert.rejects(h.invoke(), (error: any) => error.statusCode === 404)
    assert.deepEqual(h.requests, [])
    assert.deepEqual(h.completions, [])
    assert.deepEqual(h.writes, [])
  })
}

test('Gemini entry: JSON-array reader failure throws without opening SSE', async () => {
  const h = harness('gemini-generate', { stream: true, array: true, failure: 'read' })
  await assert.rejects(h.invoke(), (error: any) => error.statusCode === 500 && error.message === 'upstream unavailable')
  assert.equal(h.response.headersSent, false)
  assert.deepEqual(h.writes, [])
  assert.equal(h.timers.size, 0)
  assert.equal(h.endCount, 0)
})
