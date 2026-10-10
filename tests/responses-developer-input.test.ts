import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { OpenAIResponsesParser } from '../server/protocols/openai-responses.ts'
import { formatErrorResponse } from '../server/utils/error.ts'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('Run via tests/run-all.sh')
const { OpenAIResponsesAdapter } = require(`${build}/../builtin/provider-openai/openai-responses.js`)

// Capture actual HTTP bodies so a nonempty developer input cannot silently
// migrate into instructions and leave an invalid empty input behind.
const validationMessage = `One of "input" or "previous_response_id" or 'prompt' or 'conversation' must be provided`
const captured: any[] = []
const server = createServer(async (request, response) => {
  let text = ''
  for await (const chunk of request) text += chunk.toString()
  const body = JSON.parse(text)
  captured.push(body)
  assert.equal(request.url, '/responses')
  // This is a controlled validator, not evidence of a real provider's policy.
  if (!body.input?.length) {
    response.writeHead(400, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: validationMessage, type: 'invalid_request_error' } }))
    return
  }
  const completed = { status: 'completed', output: [] }
  if (body.stream) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`)
    return
  }
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(completed))
})

try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const adapter = new OpenAIResponsesAdapter({
    name: 'local-validation-fixture', models: [{ id: 'test-model' }],
    connection: { base_url: `http://127.0.0.1:${address.port}`, api_key: 'fixture-not-a-credential', timeout: 2000, max_retries: 0 }
  })
  const parser = new OpenAIResponsesParser()
  const developer = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Reply with OK.' }] }
  for (const stream of [false, true]) {
    const incoming = { model: 'test-model', input: [developer], stream }
    const unified = parser.parseRequest(incoming)
    assert.deepEqual(unified.messages, [{ role: 'developer', content: [{ type: 'text', text: 'Reply with OK.' }] }])
    assert.equal(unified.config.systemPrompt, undefined)
    const payload = adapter.toProviderRequest(unified)
    if (stream) {
      const wire = await new Response(await adapter.callStream(payload)).text()
      assert.ok(wire.includes('response.completed'))
    } else {
      assert.equal((await adapter.call(payload)).status, 'completed')
    }
    assert.deepEqual(captured.at(-1), {
      model: 'test-model', instructions: '', input: [developer], stream
    })
    console.log('Captured upstream JSON:', JSON.stringify(captured.at(-1)))

    // Keep the failure-path proof: truly empty input still exposes the upstream error.
    const emptyPayload = adapter.toProviderRequest(parser.parseRequest({ model: 'test-model', input: [], stream }))
    await assert.rejects(
      stream ? adapter.callStream(emptyPayload) : adapter.call(emptyPayload),
      (error: any) => {
        assert.equal(error.message, validationMessage)
        assert.equal(error._statusCode, 400)
        assert.equal(error._providerError, true)
        assert.deepEqual(formatErrorResponse(error), {
          error: { message: validationMessage, type: 'invalid_request_error', code: null },
          source: 'local-validation-fixture'
        })
        return true
      }
    )
  }
  const control = parser.parseRequest({ model: 'test-model', input: [developer, { role: 'user', content: 'Go.' }] })
  await adapter.call(adapter.toProviderRequest(control))
  assert.deepEqual(captured.at(-1).input, [developer, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Go.' }] }])
  const mixed = parser.parseRequest({ model: 'test-model', instructions: 'Instructions.', input: [
    { role: 'system', content: 'System.' },
    { role: 'developer', content: 'First.' },
    { role: 'user', content: 'Question.' },
    { role: 'developer', content: 'Second.' }
  ] })
  await adapter.call(adapter.toProviderRequest(mixed))
  assert.equal(captured.at(-1).instructions, 'Instructions.\nSystem.')
  assert.deepEqual(captured.at(-1).input, [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'First.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Question.' }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Second.' }] }
  ])
  console.log('PASS: developer role/content/order preserved in upstream JSON; sync and stream succeed; empty-input error still propagates.')
} finally {
  server.closeAllConnections()
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
