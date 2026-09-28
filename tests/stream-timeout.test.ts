import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) throw new Error('ADAPTER_BUILD not set — run via tests/run-all.sh')

const adapters = [
  ['OpenAI', require(`${buildDir}/providers/openai.js`).OpenAIAdapter, {}],
  ['Claude', require(`${buildDir}/providers/claude.js`).ClaudeAdapter, {}],
  ['Gemini', require(`${buildDir}/providers/gemini.js`).GeminiAdapter, { modelId: 'test', payload: {} }]
] as const

// Let the adapter's async fetch/read/enqueue chain settle after advancing time.
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

for (const [name, Adapter, request] of adapters) {
  for (const timeout of [30000, 80000]) {
    test(`${name}: each stream read gets the full ${timeout}ms timeout`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      let upstream!: ReadableStreamDefaultController<Uint8Array>
      t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
        start(controller) { upstream = controller }
      })))
      const adapter = new Adapter({
        name: 'test', models: [],
        connection: { base_url: 'https://example.invalid', api_key: 'test', enable_timeout: true, timeout }
      })
      const reader = adapter.callStream(request).getReader()
      let outcome = 'pending'
      const first = reader.read().then(
        (value: ReadableStreamReadResult<Uint8Array>) => { outcome = 'data'; return value },
        (error: Error) => { outcome = 'error'; throw error }
      )
      // Attach a handler before advancing time so a regression is not unhandled.
      first.catch(() => {})
      await settle()
      t.mock.timers.tick(timeout * 0.75)
      await settle()
      assert.equal(outcome, 'pending', 'must survive an idle gap longer than half the configured timeout')
      upstream.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'))
      assert.equal((await first).done, false)
      await settle()

      // A new read starts a fresh idle deadline, rather than a total stream deadline.
      let timedOut = false
      const expired = assert.rejects(reader.read(), (error: Error) => {
        timedOut = true
        assert.equal(error.message, `Upstream stream read timeout (${timeout}ms)`)
        return true
      })
      t.mock.timers.tick(timeout - 1)
      await settle()
      assert.equal(timedOut, false, 'must not expire before the new read deadline')
      t.mock.timers.tick(1)
      await expired
    })
  }

  test(`${name}: disabling timeout permits long idle gaps`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let upstream!: ReadableStreamDefaultController<Uint8Array>
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
      start(controller) { upstream = controller }
    })))
    const adapter = new Adapter({
      name: 'test', models: [],
      connection: { base_url: 'https://example.invalid', api_key: 'test', enable_timeout: false, timeout: 30000 }
    })
    const reader = adapter.callStream(request).getReader()
    const first = reader.read()
    await settle()
    t.mock.timers.tick(120000)
    await settle()
    upstream.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'))
    upstream.close()
    assert.equal((await first).done, false)
    while (!(await reader.read()).done) {}
  })
}
