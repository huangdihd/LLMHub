import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import type { CompletionInfo, HookContext } from '../server/core/hooks.ts'

// Keep the real route, pipeline and wire codecs; replace only provider I/O,
// Nitro globals and the clock. Only a third-party onComplete observer is installed.
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
  noUsage?: boolean
  multipleUsage?: boolean
  disconnect?: boolean
  completionHook?: () => void | Promise<void>
  embeddingModel?: string
  stream?: boolean
  failure?: Failure
  embedding?: 'openai' | 'embedContent' | 'batchEmbedContents'
  body?: unknown
  parseFailure?: boolean
}

function harness(protocol: Protocol, options: HarnessOptions = {}) {
  const writes: string[] = []
  const completions: CompletionInfo[] = []
  const contexts: HookContext[] = []
  let upstreamEOF = false
  const requests: any[] = []
  const timers = new Set<() => void>()
  const failure = Object.assign(new Error('upstream unavailable'), { _providerError: true, statusCode: 502 })
  const response = Object.assign(new EventEmitter(), {
    headersSent: false, writableEnded: false,
    flushHeaders() { this.headersSent = true },
    write(value: string) { assert.equal(this.writableEnded, false); writes.push(value) },
    end() { this.writableEnded = true }
  })
  const forbidden = () => { throw new Error('Unexpected external I/O') }
  const globals = {
    Buffer, TextDecoder, TextEncoder, ReadableStream, Error,
    console: { log() {}, error() {} }, fetch: forbidden,
    defineEventHandler: (handler: unknown) => handler,
    readBody: async (event: any) => {
      if (options.parseFailure) throw new Error('invalid JSON')
      return event.body
    },
    getQuery: () => ({ alt: 'sse' }),
    createError: (details: any) => Object.assign(new Error(details.message || details.statusMessage), details),
    throwFormattedError: (error: unknown) => { throw error },
    formatErrorResponse: (error: any) => ({ error: { message: error.message, code: null } }),
    setResponseHeaders: () => {},
    setResponseStatus: () => {},
    setInterval: (callback: () => void, milliseconds: number) => {
      assert.equal(milliseconds, 15000)
      timers.add(callback)
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
        `data: ${JSON.stringify({ type: 'content', delta: 'Hello' })}\n\n`,
        ...(options.multipleUsage ? [`data: ${JSON.stringify({ type: 'content', delta: '', usage: { promptTokens: 1, completionTokens: 1 } })}\n\n`] : []),
        `data: ${JSON.stringify({ type: 'done', finishReason: 'stop', usage: options.noUsage ? undefined : usage })}\n\n`,
        'data: [DONE]\n\n'
      ]
      return { getReader: () => ({ async read() {
        for (const callback of timers) callback()
        if (options.failure === 'read' && index === 1) throw failure
        if (options.disconnect && index === 1) response.emit('close')
        if (index === chunks.length) { upstreamEOF = true; return { done: true } }
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
      return { model: options.embeddingModel ?? 'offline/returned-model', embeddings: request.input.map(() => [0.5, -0.25]), usage }
    }
    async callLLM(request: any) {
      requests.push(plain(request))
      if (options.failure === 'call') throw failure
      return { id: 'answer-1', model: 'offline/model', content: [{ type: 'text', text: 'Hello' }], finishReason: 'stop', usage: options.noUsage ? undefined : usage }
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
    onComplete: async (completion: CompletionInfo, context: HookContext) => {
      completions.push(completion)
      contexts.push(context)
      await options.completionHook?.()
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
  if (Object.hasOwn(options, 'body')) Object.assign(event, { body: options.body })
  return { invoke: () => handler(event), writes, completions, contexts, requests, timers, response, failure,
    drain: () => load('server/core/pipeline.ts').drainCompletions(),
    get upstreamEOF() { return upstreamEOF } }
}

function assertCompletion(h: ReturnType<typeof harness>, model: string | undefined, expectedUsage: unknown) {
  assert.equal(h.completions.length, 1, 'one completion per request')
  assert.equal(h.completions[0].model, model)
  assert.deepEqual(h.completions[0].usage === undefined ? undefined : plain(h.completions[0].usage), expectedUsage)
  assert.equal(h.response.listenerCount('close'), 0, 'completion removes disconnect listener')
}

for (const protocol of Object.keys(definitions) as Protocol[]) {
  for (const stream of [false, true]) {
    test(`${protocol} completion: ${stream ? 'stream' : 'nonstream'} third-party observer receives final usage once`, async () => {
      const h = harness(protocol, { stream, multipleUsage: stream })
      const result = await h.invoke()
      await h.drain()
      assert.ok(JSON.stringify(result ?? h.writes).includes('Hello'))
      assertCompletion(h, 'offline/model', usage)
      assert.equal(h.completions[0].error, undefined)
      assert.equal(h.contexts[0].incomingProtocol, protocol)
      assert.equal(h.contexts[0].providerName, 'offline')
    })

    if (stream) test(`${protocol} completion: stream missing usage stays absent`, async () => {
      const h = harness(protocol, { stream, noUsage: true })
      await h.invoke()
      await h.drain()
      assertCompletion(h, 'offline/model', undefined)
      assert.equal(h.completions[0].error, undefined)
    })

    test(`${protocol} completion: throwing plugin cannot change ${stream ? 'stream' : 'nonstream'} response`, async () => {
      const h = harness(protocol, { stream, completionHook: () => { throw new Error('plugin failed') } })
      const result = await h.invoke()
      await h.drain()
      assert.ok(JSON.stringify(result ?? h.writes).includes('Hello'))
      assertCompletion(h, 'offline/model', usage)
      assert.equal(h.completions[0].error, undefined)
    })

    test(`${protocol} completion: slow plugin does not block ${stream ? 'stream' : 'nonstream'} response`, { timeout: 5000 }, async () => {
      let release!: () => void
      let finished = false
      const barrier = new Promise<void>(resolve => { release = resolve })
      const h = harness(protocol, { stream, completionHook: async () => { await barrier; finished = true } })
      try {
        const result = await h.invoke()
        assert.ok(JSON.stringify(result ?? h.writes).includes('Hello'))
        assert.equal(finished, false)
        assert.equal(h.completions.length, 1)
        if (stream) assert.equal(h.response.writableEnded, true)
      } finally {
        release()
        await h.drain()
      }
      assert.equal(finished, true)
      assertCompletion(h, 'offline/model', usage)
    })
  }

  for (const failure of ['call', 'open', 'read'] as const) {
    test(`${protocol} completion: ${failure} failure is observed exactly once`, async () => {
      const h = harness(protocol, { failure, stream: failure !== 'call' })
      if (failure === 'read') {
        await h.invoke()
        assert.ok(h.writes.join('').includes('upstream unavailable'))
      } else {
        await assert.rejects(h.invoke(), error => error === h.failure)
      }
      await h.drain()
      assertCompletion(h, 'offline/model', undefined)
      assert.equal(h.completions[0].error, h.failure)
    })
  }

  test(`${protocol} completion: parsing failure is observed before model resolution`, async () => {
    const h = harness(protocol, { parseFailure: true })
    await assert.rejects(h.invoke())
    await h.drain()
    assertCompletion(h, undefined, undefined)
    assert.match(String(h.completions[0].error), /invalid JSON/)
    assert.deepEqual(h.requests, [])
  })

  test(`${protocol} completion: client close retains final upstream usage through EOF`, async () => {
    const h = harness(protocol, { stream: true, disconnect: true, multipleUsage: true })
    await h.invoke()
    await h.drain()
    assert.equal(h.upstreamEOF, true)
    assertCompletion(h, 'offline/model', usage)
    assert.equal((h.completions[0].error as Error).message, 'Client disconnected')
  })
}

for (const embedding of ['openai', 'embedContent', 'batchEmbedContents'] as const) {
  const body = { model: 'offline/model', input: 'hello', content: 'hello', requests: [{ content: 'hello' }] }
  for (const embeddingModel of ['returned-model', 'different/returned-model']) {
    test(`${embedding} completion: response model ${embeddingModel} and normalized token usage`, async () => {
      const h = harness('gemini-generate', { embedding, body, embeddingModel })
      const result = await h.invoke()
      await h.drain()
      assert.ok(JSON.stringify(result).includes('0.5'))
      assertCompletion(h, embeddingModel.includes('/') ? embeddingModel : `offline/${embeddingModel}`, { promptTokens: 10, completionTokens: 0 })
      assert.equal(h.completions[0].error, undefined)
      assert.equal(h.contexts[0].incomingProtocol, embedding === 'openai' ? 'openai-embedding' : 'gemini-embedding')
    })
  }
  test(`${embedding} completion: provider error is observed once`, async () => {
    const h = harness('gemini-generate', { embedding, body, failure: 'call' })
    await assert.rejects(h.invoke(), error => error === h.failure)
    await h.drain()
    assertCompletion(h, 'offline/model', undefined)
    assert.equal(h.completions[0].error, h.failure)
  })
  test(`${embedding} completion: body parsing error is observed once`, async () => {
    const h = harness('gemini-generate', { embedding, body, parseFailure: true })
    await assert.rejects(h.invoke())
    await h.drain()
    assertCompletion(h, undefined, undefined)
    assert.match(String(h.completions[0].error), /invalid JSON/)
    assert.deepEqual(h.requests, [])
  })
}

for (const embedding of ['openai', 'embedContent', 'batchEmbedContents'] as const) {
  for (const behavior of ['throw', 'slow'] as const) {
    test(`${embedding} completion: ${behavior} plugin does not affect embedding response`, { timeout: 5000 }, async () => {
      let release!: () => void
      let finished = false
      const barrier = new Promise<void>(resolve => { release = resolve })
      const h = harness('gemini-generate', {
        embedding,
        body: { model: 'offline/model', input: 'hello', content: 'hello', requests: [{ content: 'hello' }] },
        completionHook: async () => {
          if (behavior === 'throw') throw new Error('plugin failed')
          await barrier
          finished = true
        }
      })
      try {
        const result = await h.invoke()
        assert.ok(JSON.stringify(result).includes('0.5'))
        assert.equal(finished, false)
        assert.equal(h.completions.length, 1)
      } finally {
        release()
        await h.drain()
      }
      assertCompletion(h, 'offline/returned-model', { promptTokens: 10, completionTokens: 0 })
      assert.equal(h.completions[0].error, undefined)
      assert.equal(finished, behavior === 'slow')
    })
  }
}
