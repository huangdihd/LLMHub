import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('Run via tests/run-all.sh')
const { HookRegistry } = require(`${build}/core/hooks.js`)
const { RequestPipeline } = require(`${build}/core/pipeline.js`)
const context = { incomingProtocol: 'test' }
const request = () => ({ model: 'first/model', messages: [], config: {} })

function harness(hooks = new HookRegistry()) {
  const calls: any[] = []
  const configuration = { name: 'first', connection: {} }
  const adapter = {
    fromProviderStreamChunk: (chunk: any, state: any) => {
      state.count = (state.count || 0) + 1
      calls.push(state.count)
      return chunk
    },
    toProviderRequest: (value: any) => value,
    callStream: (value: any) => { calls.push(value); return new ReadableStream() }
  }
  const manager = {
    resolveAdapter: (model: string) => ({ adapter, providerName: model.split('/')[0] }),
    getProviderConfig: () => configuration,
    buildGatewayError: (message: string, status: number) => Object.assign(new Error(message), { _statusCode: status }),
    callLLM: async (value: any) => { calls.push(value); return { content: 'answer', usage: { promptTokens: 2, completionTokens: 3 } } }
  }
  const pipeline = new RequestPipeline(manager, { context: { _apiKeyRecord: { name: 'test-key' } } }, 'test', hooks)
  return { pipeline, adapter, calls, configuration }
}

function stream(text: string) {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
    controller.close()
  } })
}

test('hook registration is stable, rejects duplicate IDs and unregisters', async () => {
  const hooks = new HookRegistry()
  const order: string[] = []
  const unregister = hooks.register({ id: 'last', priority: 20, onRequest: () => { order.push('last') } })
  hooks.register({ id: 'first', priority: -1, onRequest: () => { order.push('first') } })
  hooks.register({ id: 'second', priority: -1, onRequest: () => { order.push('second') } })
  assert.throws(() => hooks.register({ id: 'first' }), /already registered/)
  assert.throws(() => hooks.register({ id: '' }), /empty/)
  await hooks.request(request(), context)
  assert.deepEqual(order, ['first', 'second', 'last'])
  unregister()
  order.length = 0
  await hooks.request(request(), context)
  assert.deepEqual(order, ['first', 'second'])
})

test('request replacements reach upstream and re-resolve provider context', async () => {
  const hooks = new HookRegistry()
  hooks.register({ id: 'rewrite', onRequest: (value: any, metadata: any) => {
    assert.equal(metadata.providerName, 'first')
    assert.equal(metadata.apiKeyRecord.name, 'test-key')
    return { ...value, model: 'second/new-model' }
  } })
  const { pipeline, calls, configuration } = harness(hooks)
  const prepared = await pipeline.prepare(request())
  assert.equal(prepared.resolved.providerName, 'second')
  assert.equal(pipeline.context.providerConfig, configuration)
  await pipeline.call(prepared.request)
  assert.equal(calls[0].model, 'second/new-model')
})

test('stream hooks rewrite, drop and expand before later hooks', async () => {
  const hooks = new HookRegistry()
  hooks.register({ id: 'expand', onStreamChunk: (chunk: any) => chunk.delta === 'drop' ? null : [chunk, { ...chunk, delta: 'copy' }] })
  hooks.register({ id: 'rewrite', onStreamChunk: (chunk: any) => ({ ...chunk, delta: `${chunk.delta}!` }) })
  assert.deepEqual(await hooks.streamChunk({ type: 'content', delta: 'hello' }, context), [
    { type: 'content', delta: 'hello!' }, { type: 'content', delta: 'copy!' }
  ])
  assert.deepEqual(await hooks.streamChunk({ type: 'content', delta: 'drop' }, context), [])
})

test('request hook failure aborts as gateway error; other hook failures log and continue', async () => {
  const hooks = new HookRegistry()
  const failure = new Error('hook failed')
  const fail = () => { throw failure }
  hooks.register({ id: 'broken', onRequest: fail, onResponse: fail, onStreamChunk: fail, onError: fail, onComplete: fail })
  const { pipeline, calls } = harness(hooks)
  await assert.rejects(pipeline.prepare(request()), { message: 'hook failed', _statusCode: 500 })
  assert.equal(calls.length, 0)
  const logs: any[] = []
  const original = console.error
  console.error = (...values) => { logs.push(values) }
  try {
    const response = { content: 'answer' }
    const chunk = { type: 'content', delta: 'hello' }
    assert.equal(await hooks.response(response, context), response)
    assert.deepEqual(await hooks.streamChunk(chunk, context), [chunk])
    await hooks.error(failure, context)
    await hooks.complete({}, context)
    assert.equal(logs.length, 4)
  } finally { console.error = original }
})

test('pipeline preserves split UTF-8, malformed-line recovery, state, marker and late usage', async () => {
  const hooks = new HookRegistry()
  const completions: any[] = []
  const errors: any[] = []
  hooks.register({ id: 'observe', onError: (error: any) => { errors.push(error) }, onComplete: (value: any) => { completions.push(value) } })
  const { pipeline, adapter, calls } = harness(hooks)
  const chunks: any[] = []
  let markers = 0
  const dropped: any[] = []
  const usage = { promptTokens: 7, completionTokens: 4 }
  const text = 'event: ignored\ndata: {bad}\ndata: {"type":"content","delta":"维拉"}\n' +
    'data: {"type":"done"}\ndata: [DONE]\n' + `data: ${JSON.stringify({ type: 'done', usage })}`
  await pipeline.consumeStream(stream(text), adapter, {
    onChunks: (values: any[]) => { chunks.push(...values) },
    onDoneMarker: () => { markers++ },
    onChunkError: (error: any) => { dropped.push(error) }
  })
  await pipeline.error(errors[0])
  await pipeline.complete()
  await pipeline.complete()
  assert.deepEqual(calls, [1, 2, 3])
  assert.equal(chunks[0].delta, '维拉')
  assert.equal(markers, 1)
  assert.equal(dropped.length, 1)
  assert.equal(errors.length, 1)
  assert.equal(completions.length, 1)
  assert.deepEqual(completions[0].usage, usage)
})

test('response hooks run before serialization and completion sees final usage', async () => {
  const hooks = new HookRegistry()
  let completion: any
  hooks.register({ id: 'response', onResponse: (value: any) => ({ ...value, content: 'changed' }), onComplete: (value: any) => { completion = value } })
  const { pipeline } = harness(hooks)
  assert.equal((await pipeline.call(request())).content, 'changed')
  await pipeline.complete()
  assert.deepEqual(completion.usage, { promptTokens: 2, completionTokens: 3 })
})
