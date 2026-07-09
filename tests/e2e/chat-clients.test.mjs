// Chat-page contract: reproduces exactly the SDK client configs pages/chat.vue
// against the locally running gateway + mock.
import assert from 'node:assert/strict'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI } from '@google/genai'

const GATEWAY = 'http://127.0.0.1:3999'
const KEY = 'llmhub-e2e-test-key'

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`) }
  catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${e.message.split('\n')[0]}`) }
}

console.log('custom-key mode (same config as chat.vue makeXxxClient)')

await test('openai client: chat stream works', async () => {
  const client = new OpenAI({ baseURL: `${GATEWAY}/api/openai`, apiKey: KEY, dangerouslyAllowBrowser: true, defaultHeaders: {} })
  const stream = await client.chat.completions.create({ model: '_e2e-openai/text', messages: [{ role: 'user', content: 'hi' }], stream: true })
  let text = ''
  for await (const c of stream) text += c.choices[0]?.delta?.content || ''
  assert.ok(text.length > 0)
})

await test('openai client: responses stream works', async () => {
  const client = new OpenAI({ baseURL: `${GATEWAY}/api/openai`, apiKey: KEY, dangerouslyAllowBrowser: true, defaultHeaders: {} })
  const stream = await client.responses.create({ model: '_e2e-openai/text', input: [{ role: 'user', content: 'hi' }], stream: true })
  let text = ''
  for await (const ev of stream) if (ev.type === 'response.output_text.delta') text += ev.delta
  assert.ok(text.length > 0)
})

await test('anthropic client: messages stream works', async () => {
  const client = new Anthropic({ baseURL: `${GATEWAY}/api/claude`, apiKey: KEY, dangerouslyAllowBrowser: true, defaultHeaders: {} })
  const stream = client.messages.stream({ model: '_e2e-claude/text', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] })
  let text = ''
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') text += ev.delta.text
  }
  assert.ok(text.length > 0)
})

await test('gemini client: generateContentStream works', async () => {
  const client = new GoogleGenAI({ apiKey: KEY, httpOptions: { baseUrl: `${GATEWAY}/api/gemini`, headers: {} } })
  const stream = await client.models.generateContentStream({ model: '_e2e-gemini/text', contents: 'hi' })
  let text = ''
  for await (const c of stream) {
    for (const p of c.candidates?.[0]?.content?.parts || []) if (p.text && !p.thought) text += p.text
  }
  assert.ok(text.length > 0)
})

console.log('session mode: SDK auth headers must be fully suppressed')
// Without a session cookie the gateway must answer "API Key required"
// (= no auth header reached it), NOT "Invalid API Key" (= a dummy key leaked).

await test('openai client: Authorization: null removes the header', async () => {
  const client = new OpenAI({
    baseURL: `${GATEWAY}/api/openai`, apiKey: 'session', dangerouslyAllowBrowser: true,
    defaultHeaders: { Authorization: null }, maxRetries: 0
  })
  await assert.rejects(
    client.chat.completions.create({ model: '_e2e-openai/text', messages: [{ role: 'user', content: 'hi' }] }),
    (e) => {
      assert.match(String(e.message), /API Key required/i, `expected "API Key required", got: ${e.message}`)
      return true
    }
  )
})

await test('anthropic client: x-api-key: null removes the header', async () => {
  const client = new Anthropic({
    baseURL: `${GATEWAY}/api/claude`, apiKey: 'session', dangerouslyAllowBrowser: true,
    defaultHeaders: { 'x-api-key': null }, maxRetries: 0
  })
  await assert.rejects(
    client.messages.create({ model: '_e2e-claude/text', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
    (e) => {
      assert.match(String(e.message), /API Key required/i, `expected "API Key required", got: ${e.message}`)
      return true
    }
  )
})

await test('gemini client: empty apiKey sends no x-goog-api-key header', async () => {
  const client = new GoogleGenAI({ apiKey: '', httpOptions: { baseUrl: `${GATEWAY}/api/gemini`, headers: {} } })
  await assert.rejects(
    client.models.generateContent({ model: '_e2e-gemini/text', contents: 'hi' }),
    (e) => {
      assert.match(String(e.message), /API Key required/i, `expected "API Key required", got: ${e.message}`)
      return true
    }
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
