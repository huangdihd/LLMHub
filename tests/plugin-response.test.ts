import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const definitions = {
  openai: ['builtin/ingress-openai/server/api/openai/chat/completions.post.ts', 'openai-chat', 'OpenAIChat'],
  claude: ['builtin/ingress-claude/server/api/claude/v1/messages.post.ts', 'claude-messages', 'ClaudeMessages'],
  gemini: ['builtin/ingress-gemini/server/api/gemini/[version]/[...].ts', 'gemini-generate', 'GeminiGenerate']
} as const
type Protocol = keyof typeof definitions
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))
const usage = { promptTokens: 7, completionTokens: 3, cachedTokens: 2 }
const answer = () => ({ content: 'Plugin answer', finishReason: 'stop', usage: { ...usage } })
const request = () => ({ model: 'virtual/model', messages: [], config: {} })
const sources = new Map<string, string>()

// Real hooks, pipeline, middleware, handlers and codecs; only transport, identity
// storage and provider I/O are substituted. Each harness owns its singleton registry.
function harness(protocol: Protocol = 'openai', stream = false) {
  const writes: string[] = []
  const completions: any[] = []
  const errors: any[] = []
  const providerCalls: string[] = []
  const timers = new Set<unknown>()
  let headers: Record<string, string> = {}
  let endCount = 0
  let admissionRejected = false
  const response = Object.assign(new EventEmitter(), {
    headersSent: false, writableEnded: false,
    flushHeaders() { this.headersSent = true },
    write(value: string) { assert.equal(this.writableEnded, false); writes.push(value) },
    end() { this.writableEnded = true; endCount++ }
  })
  const forbidden = (operation: string): never => {
    providerCalls.push(operation)
    throw new Error(`Unexpected provider I/O: ${operation}`)
  }
  class ProviderManager {
    async loadProviders() {}
    getParser() { return new (load(`builtin/ingress-${protocol}/${definitions[protocol][1]}.ts`)[`${definitions[protocol][2]}Parser`])() }
    getSerializer() { return new (load(`builtin/ingress-${protocol}/${definitions[protocol][1]}-serializer.ts`)[`${definitions[protocol][2]}Serializer`])() }
    resolveAdapter() { return forbidden('resolveAdapter') }
    getProviderConfig() { return undefined }
    getRequestContext() { return { providerName: undefined, providerConfig: undefined } }
    buildGatewayError(message: string, statusCode: number) { return Object.assign(new Error(message), { _statusCode: statusCode, statusCode }) }
    async callLLM() { return forbidden('callLLM') }
    async getModels() { providerCalls.push('models'); return [{ id: 'virtual/model', name: 'model', provider: 'virtual' }] }
    async embed(value: any) { providerCalls.push('embed'); return { model: value.model, embeddings: [[0.5]], usage: { promptTokens: 4, totalTokens: 4 } } }
  }
  const event = {
    method: 'POST', path: `/api/${protocol}/generation`, node: { res: response },
    context: { params: { _: `models/virtual%2Fmodel:${stream ? 'streamGenerateContent' : 'generateContent'}` } },
    body: { model: 'virtual/model', stream, max_tokens: 32, input: 'Hi',
      messages: [{ role: 'user', content: 'Hi' }], contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] }
  }
  const globals = {
    structuredClone, Buffer, TextEncoder, TextDecoder, ReadableStream, Error, setTimeout, clearTimeout,
    console: { log() {}, error() {} },
    defineEventHandler: (handler: unknown) => handler,
    readBody: async (value: any) => value.body,
    getQuery: () => ({ alt: 'sse' }), getCookie: () => undefined,
    createError: (details: any) => Object.assign(new Error(details.message || details.statusMessage), details),
    throwFormattedError: (error: unknown) => { throw error },
    formatErrorResponse: (error: any) => ({ error: { message: error.message } }),
    setResponseHeaders: (_event: unknown, value: Record<string, string>) => { headers = value },
    setResponseStatus: () => {},
    setInterval: (callback: unknown) => { timers.add(callback); return callback },
    clearInterval: (callback: unknown) => { assert.ok(timers.delete(callback)) }
  }
  const cache = new Map<string, any>()
  function load(path: string): any {
    const filename = resolve(root, path)
    if (filename === resolve(root, 'server/providers/manager.ts')) return { ProviderManager }
    if (filename === resolve(root, 'server/stores/auth.store.ts')) return { getAuthStore: () => ({ getKeyRecord: async () => ({ name: 'test-key' }) }) }
    if (filename === resolve(root, 'server/core/ingress-registry.ts')) return { ingressRegistry: { match: () => ({
      id: protocol, extractKey: () => 'test-key',
      extractModel: async () => ({ model: event.body.model, replace: (model: string) => { event.body.model = model } }),
      sendError: (_event: unknown, rejection: unknown) => { admissionRejected = true; return rejection }
    }) } }
    if (cache.has(filename)) return cache.get(filename)
    assert.ok(filename.startsWith(`${root}server/`) || filename.startsWith(`${root}builtin/`), filename)
    if (!sources.has(filename)) sources.set(filename, ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText)
    const module = { exports: {} }
    cache.set(filename, module.exports)
    runInNewContext(sources.get(filename)!, { ...globals, module, exports: module.exports,
      require: (specifier: string) => {
        if (specifier === 'h3') return { getHeader: () => undefined }
        assert.ok(specifier.startsWith('.'), `Unexpected external dependency: ${specifier}`)
        return load(resolve(dirname(filename), specifier.endsWith('.ts') ? specifier : `${specifier}.ts`))
      }
    }, { filename })
    return module.exports
  }
  const hooks = load('server/core/hooks.ts').requestHooks
  const events = load('server/core/events.ts').systemEvents
  events.subscribe('test', 'llmhub:request-complete', ({ completion }: any) => { completions.push(completion) })
  events.subscribe('test', 'llmhub:request-error', ({ error }: any) => { errors.push(error) })
  return {
    hooks, load, event, writes, completions, errors, providerCalls, timers, response,
    manager: new ProviderManager(),
    invoke: () => load(definitions[protocol][0]).default(event),
    async admittedInvoke() {
      const result = await load('server/middleware/ingress-auth.ts').default(event)
      return admissionRejected ? result : load(definitions[protocol][0]).default(event)
    },
    drain: () => load('server/core/pipeline.ts').drainCompletions(),
    get headers() { return headers }, get endCount() { return endCount }
  }
}

function frames(writes: string[]) {
  return writes.join('').split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)))
}

for (const protocol of Object.keys(definitions) as Protocol[]) {
  for (const stream of [false, true]) {
    for (const responseKind of ['string', 'structured'] as const) {
      test(`${protocol}: plugin ${responseKind} ${stream ? 'stream' : 'nonstream'} uses native framing without resolving a provider`, async () => {
        const instance = harness(protocol, stream)
        instance.hooks.register({ id: 'local-answer', onRequest: () => ({ response: responseKind === 'string' ? 'Plugin answer' : answer() }) }, 'test-plugin')
        const result = await instance.invoke()
        await instance.drain()
        assert.deepEqual(instance.providerCalls, [])
        assert.equal(instance.completions.length, 1)
        assert.deepEqual(plain(instance.completions[0].responseSource), { pluginId: 'test-plugin', hookId: 'local-answer' })
        assert.equal(instance.completions[0].error, undefined)
        assert.deepEqual(plain(instance.completions[0].usage), responseKind === 'string' ? { promptTokens: 0, completionTokens: 0 } : usage)
        assert.equal(instance.response.listenerCount('close'), 0)
        if (!stream) {
          const wire = plain(result)
          if (protocol === 'openai') assert.equal(wire.choices[0].message.content, 'Plugin answer')
          if (protocol === 'claude') assert.equal(wire.content[0].text, 'Plugin answer')
          if (protocol === 'gemini') assert.equal(wire.candidates[0].content.parts[0].text, 'Plugin answer')
          assert.deepEqual(instance.writes, [])
          return
        }
        assert.equal(instance.headers['Content-Type'], 'text/event-stream')
        assert.equal(instance.endCount, 1)
        assert.equal(instance.timers.size, 0)
        const values = frames(instance.writes)
        if (protocol === 'openai') {
          assert.equal(values.map(value => value.choices?.[0]?.delta?.content ?? '').join(''), 'Plugin answer')
          assert.equal(values.filter(value => value.choices?.[0]?.finish_reason === 'stop').length, 1)
          assert.equal(instance.writes.join('').split('data: [DONE]').length - 1, 1)
        }
        if (protocol === 'claude') {
          assert.equal(values.filter(value => value.type === 'content_block_delta').map(value => value.delta.text ?? '').join(''), 'Plugin answer')
          assert.equal(values.filter(value => value.type === 'message_start').length, 1)
          assert.equal(values.filter(value => value.type === 'message_stop').length, 1)
        }
        if (protocol === 'gemini') {
          assert.equal(values.flatMap(value => value.candidates?.[0]?.content?.parts ?? []).map(part => part.text ?? '').join(''), 'Plugin answer')
          assert.equal(values.filter(value => value.candidates?.[0]?.finishReason === 'STOP').length, 1)
        }
      })
    }
  }
}

test('generation preserves rewrites and stable priority, then stops at the first answer with host-owned provenance', async () => {
  const { hooks } = harness()
  const order: string[] = []
  hooks.register({ id: 'later', priority: 10, onRequest: () => { order.push('later'); throw new Error('must not run') } })
  hooks.register({ id: 'rewrite', priority: -10, onRequest: (value: any) => { order.push('rewrite'); return { ...value, model: 'rewritten/model' } } })
  hooks.register({ id: 'answer', priority: -10, onRequest: async (value: any) => {
    order.push('answer')
    assert.equal(value.model, 'rewritten/model')
    return { response: answer(), responseSource: { pluginId: 'forged', hookId: 'forged' } }
  } }, 'manifest-id')
  const result = await hooks.generation(request(), { incomingProtocol: 'test' })
  assert.deepEqual(order, ['rewrite', 'answer'])
  assert.equal(result.request.model, 'rewritten/model')
  assert.deepEqual(plain(result.response), answer())
  assert.deepEqual(plain(result.responseSource), { pluginId: 'manifest-id', hookId: 'answer' })
})

test('generation supports empty strings and defaults provenance to hook id; unregister removes ownership', async () => {
  const { hooks } = harness()
  const unregister = hooks.register({ id: 'answer', onRequest: () => ({ response: '' }) }, 'old-owner')
  unregister()
  hooks.register({ id: 'answer', onRequest: () => ({ response: '' }) })
  const result = await hooks.generation(request(), { incomingProtocol: 'test' })
  assert.equal(result.response.content, '')
  assert.equal(result.response.finishReason, 'stop')
  assert.deepEqual(plain(result.responseSource), { pluginId: 'answer', hookId: 'answer' })
})

test('legacy request and generation preserve ordinary replacement/void behavior', async () => {
  const { hooks } = harness()
  const replacement = { ...request(), model: 'rewritten/model' }
  hooks.register({ id: 'rewrite', onRequest: () => replacement })
  hooks.register({ id: 'observer', onRequest: (value: any) => { assert.equal(value, replacement) } })
  assert.equal(await hooks.request(request(), { incomingProtocol: 'test' }), replacement)
  const result = await hooks.generation(request(), { incomingProtocol: 'test' })
  assert.equal(result.request, replacement)
  assert.equal(result.response, undefined)
  assert.equal(result.responseSource, undefined)
})

for (const invalid of [null, 42, false, 'bare text', {}, { response: null }, { response: 42 }, { response: {} }]) {
  test(`invalid request-hook result ${JSON.stringify(invalid)} fails closed before provider I/O`, async () => {
    const instance = harness()
    let later = false
    instance.hooks.register({ id: 'invalid', onRequest: () => invalid })
    instance.hooks.register({ id: 'later', onRequest: () => { later = true } })
    await assert.rejects(instance.invoke(), (error: any) => {
      assert.equal(error._statusCode ?? error.statusCode, 500)
      return true
    })
    await instance.drain()
    assert.equal(later, false)
    assert.deepEqual(instance.providerCalls, [])
    assert.equal(instance.completions.length, 1)
    assert.ok(instance.completions[0].error)
    assert.equal(instance.completions[0].responseSource, undefined)
  })
}

for (const stream of [false, true]) {
  test(`plugin ${stream ? 'stream' : 'response'} hooks rewrite output; completion runs once with established usage semantics`, async () => {
    const instance = harness('openai', stream)
    const finalUsage = { promptTokens: 19, completionTokens: 11 }
    instance.hooks.register({ id: 'answer', onRequest: () => ({ response: answer() }),
      onResponse: (value: any) => ({ ...value, content: 'Rewritten', usage: finalUsage }),
      onStreamChunk: (chunk: any) => chunk.type === 'content' ? { ...chunk, delta: 'Rewritten', usage: finalUsage } : chunk
    }, 'owner')
    const result = await instance.invoke()
    await instance.drain()
    assert.ok(JSON.stringify(result ?? instance.writes).includes('Rewritten'))
    assert.equal(instance.completions.length, 1)
    // Existing streaming accounting observes input chunks, not rewritten chunks.
    assert.deepEqual(plain(instance.completions[0].usage), stream ? usage : finalUsage)
    assert.deepEqual(plain(instance.completions[0].responseSource), { pluginId: 'owner', hookId: 'answer' })
    assert.deepEqual(instance.providerCalls, [])
  })
}

for (const stage of ['onBeforeIdentity', 'onAfterIdentity', 'onModelResolved']) {
  test(`${stage}: admission rejection wins over a plugin answer`, async () => {
    const instance = harness()
    const rejection = { status: 403, message: 'denied', code: 'access_denied' }
    let answered = false
    instance.hooks.register({ id: 'deny', [stage]: () => rejection })
    instance.hooks.register({ id: 'answer', onRequest: () => { answered = true; return { response: 'must not escape' } } })
    assert.deepEqual(await instance.admittedInvoke(), rejection)
    assert.equal(answered, false)
    assert.deepEqual(instance.providerCalls, [])
    assert.deepEqual(instance.writes, [])
  })
}

test('pipeline can consume synthetic stream without an adapter and complete is idempotent', async () => {
  const instance = harness()
  instance.hooks.register({ id: 'answer', onRequest: () => ({ response: answer() }) })
  const { RequestPipeline } = instance.load('server/core/pipeline.ts')
  const pipeline = new RequestPipeline(instance.manager, instance.event, 'test')
  assert.equal(pipeline.hasResponse, false)
  const prepared = await pipeline.prepare(request())
  assert.equal(pipeline.hasResponse, true)
  assert.equal(prepared.resolved, undefined)
  const chunks: any[] = []
  await pipeline.consumeStream(await pipeline.openStream(prepared.request), undefined, {
    onChunks: (values: any[]) => { chunks.push(...values) },
    onChunkError: (error: unknown) => { throw error }
  })
  await pipeline.complete()
  await pipeline.complete()
  await instance.drain()
  assert.equal(chunks.filter(chunk => chunk.type === 'content').map(chunk => chunk.delta).join(''), 'Plugin answer')
  assert.equal(chunks.filter(chunk => chunk.type === 'done').length, 1)
  assert.equal(instance.completions.length, 1)
  assert.deepEqual(instance.providerCalls, [])
})

test('synthetic chunks preserve tool signatures and emit response logprobs only once', async () => {
  const instance = harness()
  const logprobs = [{ token: 'a', logprob: -1, bytes: [97] }]
  instance.hooks.register({ id: 'answer', onRequest: () => ({ response: {
    ...answer(),
    content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' },
      { type: 'tool_use', toolUse: { id: 'tool', name: 'run', input: {} } }],
    toolCalls: [{ id: 'tool', name: 'run', input: {}, thoughtSignature: 'REAL' }], logprobs
  } }) })
  const { RequestPipeline } = instance.load('server/core/pipeline.ts')
  const pipeline = new RequestPipeline(instance.manager, instance.event, 'test')
  await pipeline.prepare(request())
  const chunks: any[] = []
  await pipeline.consumeStream(await pipeline.openStream(request()), undefined, {
    onChunks(values: any[]) { chunks.push(...values) },
    onChunkError(error: unknown) { throw error }
  })
  assert.deepEqual(plain(chunks.flatMap(chunk => chunk.logprobs ?? [])), logprobs)
  const tools = chunks.filter(chunk => chunk.type === 'tool_call')
  assert.equal(tools.length, 1)
  assert.equal(tools[0].toolCall.thoughtSignature, 'REAL')
  await pipeline.complete()
  await instance.drain()
})

for (const protocol of Object.keys(definitions) as Protocol[]) {
  test(`${protocol}: model discovery never invokes a generation-answer hook`, async () => {
    const instance = harness(protocol)
    instance.hooks.register({ id: 'answer', onRequest: () => { throw new Error('generation hook entered model discovery') } })
    const paths = {
      gemini: 'gemini/[version]/models.get.ts',
      claude: 'claude/v1/models.get.ts',
      openai: 'openai/models.get.ts'
    }
    const path = paths[protocol]
    const result = await instance.load(`builtin/ingress-${protocol}/server/api/${path}`).default(instance.event)
    assert.ok(JSON.stringify(result).includes(protocol === 'gemini' ? 'virtual%2Fmodel' : 'virtual/model'))
    assert.deepEqual(instance.providerCalls, ['models'])
  })
}

test('embedding bypasses generation answers and retains upstream usage without responseSource', async () => {
  const instance = harness()
  instance.hooks.register({ id: 'answer', onRequest: () => { throw new Error('generation hook entered embedding') } })
  // Embedding retains its preexisting provider resolution path.
  instance.manager.resolveAdapter = () => undefined as never
  const { RequestPipeline } = instance.load('server/core/pipeline.ts')
  const pipeline = new RequestPipeline(instance.manager, instance.event, 'openai-embedding')
  const result = await pipeline.embed({ model: 'virtual/model', input: ['hello'] })
  await pipeline.complete()
  await instance.drain()
  assert.deepEqual(plain(result.embeddings), [[0.5]])
  assert.deepEqual(instance.providerCalls, ['embed'])
  assert.equal(instance.completions.length, 1)
  assert.deepEqual(plain(instance.completions[0].usage), { promptTokens: 4, completionTokens: 0 })
  assert.equal(instance.completions[0].responseSource, undefined)
})
