import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { OpenAIChatParser } from '../server/protocols/openai-chat.ts'
import { OpenAICompletionParser } from '../server/protocols/openai-completion.ts'
import { OpenAIResponsesParser } from '../server/protocols/openai-responses.ts'
import { ClaudeMessagesParser } from '../server/protocols/claude-messages.ts'
import { ClaudeCompletionParser } from '../server/protocols/claude-completion.ts'

// Adapters use TS parameter properties (not strip-only compatible),
// so they are precompiled by tests/run-all.sh into $ADAPTER_BUILD.
const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) {
  console.error('ADAPTER_BUILD not set — run via tests/run-all.sh')
  process.exit(1)
}
const { OpenAIAdapter } = require(`${buildDir}/providers/openai.js`)
const { ClaudeAdapter } = require(`${buildDir}/providers/claude.js`)
const { GeminiAdapter } = require(`${buildDir}/providers/gemini.js`)
const { GeminiGenerateParser } = require(`${buildDir}/protocols/gemini-generate.js`)

let passed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ok - ${name}`)
  } catch (e: any) {
    console.error(`  FAIL - ${name}`)
    console.error(e.message)
    process.exitCode = 1
  }
}

const dummyConfig = { name: 'test', connection: {}, models: [] }

console.log('max_tokens passthrough — parsers')

test('parsers leave maxTokens undefined when the client omits it', () => {
  const openaiChat = new OpenAIChatParser().parseRequest({ messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(openaiChat.config.maxTokens, undefined)

  const openaiCompletion = new OpenAICompletionParser().parseRequest({ prompt: 'hi' })
  assert.equal(openaiCompletion.config.maxTokens, undefined)

  const openaiResponses = new OpenAIResponsesParser().parseRequest({ input: 'hi' })
  assert.equal(openaiResponses.config.maxTokens, undefined)

  const claudeMessages = new ClaudeMessagesParser().parseRequest({ messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(claudeMessages.config.maxTokens, undefined)

  const claudeCompletion = new ClaudeCompletionParser().parseRequest({ prompt: 'hi' })
  assert.equal(claudeCompletion.config.maxTokens, undefined)

  const gemini = new GeminiGenerateParser().parseRequest({
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
  }, 'p/m')
  assert.equal(gemini.config.maxTokens, undefined)
})

test('parsers keep an explicit max_tokens value', () => {
  const req = new OpenAIChatParser().parseRequest({
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 123
  })
  assert.equal(req.config.maxTokens, 123)
})

console.log('max_tokens passthrough — adapters')

test('openai adapter omits max_tokens when unset', () => {
  const adapter = new OpenAIAdapter(dummyConfig)
  const payload = adapter.toProviderRequest({
    model: 'p/m',
    messages: [{ role: 'user', content: 'hi' }],
    config: {}
  })
  assert.ok(!('max_tokens' in payload))
})

test('openai adapter forwards max_tokens (plus thinking budget) when set', () => {
  const adapter = new OpenAIAdapter(dummyConfig)
  const payload = adapter.toProviderRequest({
    model: 'p/m',
    messages: [{ role: 'user', content: 'hi' }],
    config: { maxTokens: 100, thinkingConfig: { thinkingBudget: 50 } }
  })
  assert.equal(payload.max_tokens, 150)
})

test('claude adapter falls back to 4096 (upstream requires max_tokens)', () => {
  const adapter = new ClaudeAdapter(dummyConfig)
  const payload = adapter.toProviderRequest({
    model: 'p/m',
    messages: [{ role: 'user', content: 'hi' }],
    config: {}
  })
  assert.equal(payload.max_tokens, 4096)
})

test('claude adapter keeps an explicit maxTokens', () => {
  const adapter = new ClaudeAdapter(dummyConfig)
  const payload = adapter.toProviderRequest({
    model: 'p/m',
    messages: [{ role: 'user', content: 'hi' }],
    config: { maxTokens: 321 }
  })
  assert.equal(payload.max_tokens, 321)
})

test('gemini adapter omits maxOutputTokens when unset', () => {
  const adapter = new GeminiAdapter(dummyConfig)
  const { payload } = adapter.toProviderRequest({
    model: 'p/m',
    messages: [{ role: 'user', content: 'hi' }],
    config: {}
  })
  assert.ok(!('maxOutputTokens' in payload.generationConfig))
})

console.log(`\n${passed} tests passed${process.exitCode ? ', with FAILURES' : ''}`)
