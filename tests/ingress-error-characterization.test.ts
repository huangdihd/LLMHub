import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Set INGRESS_ERROR_SOURCE=HEAD to run these unchanged assertions against git show
// HEAD sources. Only source locations change; errors, routes and expectations do not.
const root = fileURLToPath(new URL('../', import.meta.url))
const baseline = process.env.INGRESS_ERROR_SOURCE === 'HEAD'
const definitions = {
  'openai-completion': ['openai/completions.post.ts', 'OpenAICompletion'],
  'openai-chat': ['openai/chat/completions.post.ts', 'OpenAIChat'],
  'openai-responses': ['openai/responses.post.ts', 'OpenAIResponses'],
  'claude-completion': ['claude/v1/complete.post.ts', 'ClaudeCompletion'],
  'claude-messages': ['claude/v1/messages.post.ts', 'ClaudeMessages'],
  'gemini-generate': ['gemini/[version]/[...].ts', 'GeminiGenerate']
} as const

type Protocol = keyof typeof definitions
type Failure = 'call' | 'open' | 'read'
const fixtures = [
  {
    name: 'nested provider body',
    properties: { _errorBody: { error: { message: 'Quota exhausted', type: 'rate_limit_error', code: 'quota' } }, _source: 'upstream-fixture' },
    formatted: { error: { message: 'Quota exhausted', type: 'rate_limit_error', code: 'quota' }, source: 'upstream-fixture' }
  },
  {
    name: 'flat provider body',
    properties: { _errorBody: { message: 'Flat provider message' } },
    formatted: { error: { message: 'Flat provider message', type: 'provider_error', code: null }, source: 'provider' }
  },
  {
    name: 'missing provider body',
    properties: {},
    formatted: { error: { message: 'Provider error', type: 'provider_error', code: null }, source: 'provider' }
  }
] as const

function harness(protocol: Protocol, failureStage: Failure, properties: object) {
  const family = protocol.split('-')[0]
  const packagePath = `builtin/ingress-${family}`
  const codecPath = baseline ? 'server/protocols' : packagePath
  const writes: string[] = []
  const timers = new Set<unknown>()
  const failure = Object.assign(new Error('transport failed'), { _providerError: true, _statusCode: 429 }, properties)
  let endCount = 0
  let headers: Record<string, string> = {}
  const response = {
    headersSent: false, writableEnded: false,
    flushHeaders() { this.headersSent = true },
    write(value: string) { assert.equal(this.writableEnded, false); writes.push(value) },
    end() { this.writableEnded = true; endCount++ }
  }
  const globals: Record<string, any> = {
    Buffer, TextDecoder, TextEncoder, ReadableStream, Error,
    console: { log() {}, error() {} },
    defineEventHandler: (handler: unknown) => handler,
    readBody: async (event: any) => event.body,
    getQuery: () => ({ alt: 'sse' }),
    createError: (details: any) => Object.assign(new Error(details.message || details.statusMessage), details),
    setResponseHeaders: (_event: unknown, value: Record<string, string>) => { headers = value },
    setResponseStatus: () => { throw new Error('Unexpected status override') },
    setInterval: (callback: unknown) => { timers.add(callback); return callback },
    clearInterval: (callback: unknown) => { assert.ok(timers.delete(callback)) }
  }
  const adapter = {
    name: 'offline',
    toProviderRequest: (request: unknown) => request,
    fromProviderStreamChunk: (chunk: unknown) => chunk,
    async callStream() {
      if (failureStage === 'open') throw failure
      assert.equal(failureStage, 'read')
      return { getReader: () => ({ async read() { throw failure } }) }
    }
  }
  class ProviderManager {
    async loadProviders() {}
    getParser() { return new (load(`${codecPath}/${protocol}.ts`)[`${definitions[protocol][1]}Parser`])() }
    getSerializer() { return new (load(`${codecPath}/${protocol}-serializer.ts`)[`${definitions[protocol][1]}Serializer`])() }
    resolveAdapter() { return { adapter, providerName: 'offline' } }
    getProviderConfig() { return undefined }
    buildGatewayError(message: string, statusCode: number) { return Object.assign(new Error(message), { _statusCode: statusCode }) }
    async callLLM() { assert.equal(failureStage, 'call'); throw failure }
  }
  const cache = new Map<string, any>()
  function load(path: string): any {
    const filename = resolve(root, path)
    if (filename === resolve(root, 'server/providers/manager.ts')) return { ProviderManager }
    if (filename === resolve(root, 'server/core/accounting.ts')) return {
      completeAccounting: async () => {}, completeIngressAccounting: async () => {}
    }
    if (cache.has(filename)) return cache.get(filename)
    const sourcePath = relative(root, filename)
    assert.match(sourcePath, /^(server|builtin)\//)
    const source = baseline
      ? execFileSync('git', ['show', `HEAD:${sourcePath}`], { cwd: root, encoding: 'utf8' })
      : readFileSync(filename, 'utf8')
    const module = { exports: {} }
    cache.set(filename, module.exports)
    runInNewContext(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, {
      ...globals, module, exports: module.exports,
      require: (specifier: string) => {
        assert.ok(specifier.startsWith('.'), `Unexpected external import ${specifier}`)
        return load(resolve(dirname(filename), specifier.endsWith('.ts') ? specifier : `${specifier}.ts`))
      }
    }, { filename })
    return module.exports
  }
  // Nitro auto-imports must use the real formatter, not pass-through test doubles.
  Object.assign(globals, load('server/utils/error.ts'))
  if (baseline) Object.assign(globals, load('server/utils/embedding.ts'))
  const handler = load(`${baseline ? '' : `${packagePath}/`}server/api/${definitions[protocol][0]}`).default
  const stream = failureStage !== 'call'
  const event = {
    method: 'POST', node: { res: response },
    context: { params: { _: `models/offline%2Fmodel:${stream ? 'streamGenerateContent' : 'generateContent'}` } },
    body: { model: 'offline/model', stream, max_tokens: 32, prompt: '\n\nHuman: Hi\n\nAssistant:',
      messages: [{ role: 'user', content: 'Hi' }], input: 'Hi', contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] }
  }
  return { invoke: () => handler(event), writes, response, timers,
    get headers() { return headers }, get endCount() { return endCount } }
}

for (const protocol of Object.keys(definitions) as Protocol[]) {
  for (const fixture of fixtures) {
    for (const failureStage of ['call', 'open', 'read'] as const) {
      test(`${protocol}: ${failureStage} error wire shape (${fixture.name})`, async () => {
        const instance = harness(protocol, failureStage, fixture.properties)
        if (failureStage !== 'read') {
          await assert.rejects(instance.invoke(), (error: any) => {
            // This is the exact Nitro createError boundary, not an HTTP server's
            // deployment-dependent outer H3 error envelope.
            assert.equal(error.statusCode, 429)
            assert.deepEqual(JSON.parse(JSON.stringify(error.data)), fixture.formatted)
            return true
          })
          assert.equal(instance.response.headersSent, false)
          assert.deepEqual(instance.writes, [])
          assert.equal(instance.endCount, 0)
        } else {
          await instance.invoke()
          const formatted = JSON.stringify(fixture.formatted)
          const expected = protocol === 'claude-messages'
            ? 'event: error\ndata: {"error":{"type":"api_error","message":"transport failed"}}\n\n'
            : protocol === 'claude-completion'
              ? `event: error\ndata: ${JSON.stringify({ type: 'error', error: fixture.formatted.error })}\n\n`
              : protocol === 'gemini-generate'
                ? 'data: {"error":{"message":"transport failed"}}\n\n'
                : protocol === 'openai-responses'
                  ? `event: error\ndata: ${JSON.stringify({ type: 'error', code: fixture.formatted.error.code, message: fixture.formatted.error.message, param: null, sequence_number: 2 })}\n\n`
                  : `data: ${formatted}\n\n`
          assert.equal(instance.writes.at(-1), expected)
          assert.equal(instance.writes.filter(value => value === expected).length, 1)
          assert.equal(instance.response.headersSent, true)
          assert.equal(instance.headers['Content-Type'], 'text/event-stream')
          assert.equal(instance.response.writableEnded, true)
          assert.equal(instance.endCount, 1)
        }
        assert.equal(instance.timers.size, 0)
      })
    }
  }
}
