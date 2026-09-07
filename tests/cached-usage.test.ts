import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { OpenAIChatSerializer } from '../server/protocols/openai-chat-serializer.ts'
import { OpenAICompletionSerializer } from '../server/protocols/openai-completion-serializer.ts'
import { OpenAIResponsesSerializer } from '../server/protocols/openai-responses-serializer.ts'
import { ClaudeMessagesSerializer } from '../server/protocols/claude-messages-serializer.ts'

const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) {
  console.error('ADAPTER_BUILD not set — run via tests/run-all.sh')
  process.exit(1)
}
const { OpenAIAdapter } = require(`${buildDir}/providers/openai.js`)
const { ClaudeAdapter } = require(`${buildDir}/providers/claude.js`)
const { GeminiAdapter } = require(`${buildDir}/providers/gemini.js`)
const { CodexAdapter } = require(`${buildDir}/providers/codex.js`)
const { GeminiGenerateSerializer } = require(`${buildDir}/protocols/gemini-generate-serializer.js`)

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

console.log('cached usage provider normalization')

test('OpenAI and Codex map cached input tokens', () => {
  const openai = new OpenAIAdapter(dummyConfig).fromProviderResponse({
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 7 }
    }
  })
  assert.deepEqual(openai.usage, { promptTokens: 10, completionTokens: 2, cachedTokens: 7 })

  const codex = new CodexAdapter(dummyConfig).fromProviderResponse({
    status: 'completed',
    output: [],
    usage: {
      input_tokens: 8,
      output_tokens: 3,
      input_tokens_details: { cached_tokens: 6 }
    }
  })
  assert.deepEqual(codex.usage, { promptTokens: 8, completionTokens: 3, cachedTokens: 6 })
})

test('Claude maps cache reads and creation into total prompt tokens', () => {
  const adapter = new ClaudeAdapter(dummyConfig)
  const response = adapter.fromProviderResponse({
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 3,
      output_tokens: 4,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 2
    }
  })
  assert.deepEqual(response.usage, {
    promptTokens: 10,
    completionTokens: 4,
    cachedTokens: 5,
    cacheCreationTokens: 2
  })

  const state = {}
  adapter.fromProviderStreamChunk({
    type: 'message_start',
    message: { usage: {
      input_tokens: 3,
      output_tokens: 0,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 2
    } }
  }, state)
  const done = adapter.fromProviderStreamChunk({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 4 }
  }, state)
  assert.deepEqual(done.usage, {
    promptTokens: 10,
    completionTokens: 4,
    cachedTokens: 5,
    cacheCreationTokens: 2
  })
})

test('Gemini maps cached content tokens', () => {
  const response = new GeminiAdapter(dummyConfig).fromProviderResponse({
    candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    usageMetadata: {
      promptTokenCount: 9,
      candidatesTokenCount: 2,
      cachedContentTokenCount: 7
    }
  })
  assert.deepEqual(response.usage, { promptTokens: 9, completionTokens: 2, cachedTokens: 7 })
})

console.log('cached usage downstream serialization')

const usage = { promptTokens: 10, completionTokens: 4, cachedTokens: 5, cacheCreationTokens: 2 }

test('OpenAI protocols expose cached token details', () => {
  const response = { content: 'ok', finishReason: 'stop' as const, usage }
  assert.deepEqual(
    new OpenAIChatSerializer().serializeResponse(response).usage.prompt_tokens_details,
    { cached_tokens: 5 }
  )
  assert.deepEqual(
    new OpenAICompletionSerializer().serializeResponse(response).usage.prompt_tokens_details,
    { cached_tokens: 5 }
  )
  assert.deepEqual(
    new OpenAIResponsesSerializer().serializeResponse(response).usage.input_tokens_details,
    { cached_tokens: 5 }
  )

  const streamUsage = new OpenAIChatSerializer().serializeStreamChunk({ type: 'done', usage }).usage
  assert.deepEqual(streamUsage.prompt_tokens_details, { cached_tokens: 5 })
})

test('Claude protocol restores cache fields and uncached input count', () => {
  const serializer = new ClaudeMessagesSerializer()
  const responseUsage = serializer.serializeResponse({ content: 'ok', finishReason: 'stop', usage }).usage
  assert.deepEqual(responseUsage, {
    input_tokens: 3,
    output_tokens: 4,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 2
  })
  const streamUsage = serializer.serializeStreamChunk({ type: 'done', usage }).usage
  assert.deepEqual(streamUsage, responseUsage)
})

test('Gemini protocol exposes cachedContentTokenCount', () => {
  const serializer = new GeminiGenerateSerializer()
  const response = serializer.serializeResponse({ content: 'ok', finishReason: 'stop', usage })
  assert.equal(response.usageMetadata.cachedContentTokenCount, 5)
  const done = serializer.serializeStreamChunk({ type: 'done', usage })
  assert.equal(done.usageMetadata.cachedContentTokenCount, 5)
})

console.log(`\n${passed} tests passed${process.exitCode ? ', with FAILURES' : ''}`)
