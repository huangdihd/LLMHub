import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { LLMRequest } from '../server/core/types.ts'
import type { RequestHook } from '../server/core/hooks.ts'

const module = { exports: {} as { HookRegistry: new () => {
  register(hook: RequestHook, owner?: string): unknown
  generation(request: LLMRequest, context: { incomingProtocol: string }): Promise<{ request: LLMRequest; response?: unknown }>
} } }
runInNewContext(ts.transpileModule(readFileSync(new URL('../server/core/hooks.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, { module, exports: module.exports, console })
const { HookRegistry } = module.exports
const request = (): LLMRequest => ({ messages: [{ role: 'user', content: 'Hello' }], config: {} })
const response = () => ({ content: 'Hello', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } })
async function generate(result: unknown) {
  const hooks = new HookRegistry()
  hooks.register({ id: 'shape', onRequest: () => result as LLMRequest }, 'validation-plugin')
  return hooks.generation(request(), { incomingProtocol: 'test' })
}
test('request hooks retain tools with optional description and parameters from ingress parsers', async () => {
  const value = { ...request(), tools: [{ name: 'run' }] }
  assert.equal((await generate(value)).request, value)
})

const invalid = /Plugin validation-plugin hook shape: invalid onRequest result/

const invalidResponses: Record<string, unknown> = {
  'tool result missing content': { content: [{ type: 'tool_result', toolResult: { toolUseId: 'call' } }] },
  'tool result malformed nested text': { content: [{ type: 'tool_result', toolResult: { toolUseId: 'call', content: [{ type: 'text', text: 42 }] } }] },
  'tool result invalid isError': { content: [{ type: 'tool_result', toolResult: { toolUseId: 'call', content: '', isError: 'yes' } }] },
  'image invalid secondary source': { content: [{ type: 'image', imageUrl: 'https://example.test/image', imageBase64: 12 }] },
  'image invalid media type': { content: [{ type: 'image', imageBase64: 'aA==', imageMediaType: {} }] },
  'thinking invalid kind': { content: [{ type: 'thinking', thinking: '', reasoningKind: 'bogus' }] },
  'opaque invalid provider': { content: [{ type: 'redacted_thinking', data: '', reasoningProvider: 'bogus' }] },
  'tool invalid signature': { toolCalls: [{ id: 'call', name: 'test', input: {}, thoughtSignature: {} }] },
  'tool silently lost input field': { toolCalls: [{ id: 'call', name: 'test', input: { function: () => 1 } }] },
  'logprobs non-array': { logprobs: {} },
  'logprobs invalid token': { logprobs: [{ token: 42, logprob: -1 }] },
  'logprobs non-finite': { logprobs: [{ token: 'a', logprob: NaN }] },
  'logprobs invalid bytes': { logprobs: [{ token: 'a', logprob: -1, bytes: ['97'] }] },
  'logprobs out-of-range byte': { logprobs: [{ token: 'a', logprob: -1, bytes: [256] }] },
  'logprobs fractional byte': { logprobs: [{ token: 'a', logprob: -1, bytes: [1.5] }] },
  'logprobs null alternative': { logprobs: [{ token: 'a', logprob: -1, top_logprobs: [null] }] },
  'tool non-finite input': { toolCalls: [{ id: 'call', name: 'test', input: { value: Infinity } }] },
  'tool bigint input': { toolCalls: [{ id: 'call', name: 'test', input: { value: 1n } }] },
  'tool undefined input field': { toolCalls: [{ id: 'call', name: 'test', input: { value: undefined } }] },
  'logprobs invalid alternatives': { logprobs: [{ token: 'a', logprob: -1, top_logprobs: [{ token: 'b', logprob: 'bad' }] }] },
  'array usage': { usage: Object.assign([], { promptTokens: 0, completionTokens: 0 }) },
  'sparse content': { content: new Array(1) }
}
for (const [name, fields] of Object.entries(invalidResponses)) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(generate({ response: { ...response(), ...fields as object } }), invalid)
  })
}

test('rejects circular nested content with the hook identity', async () => {
  const content: unknown[] = []
  content.push({ type: 'tool_result', toolResult: { toolUseId: 'call', content } })
  await assert.rejects(generate({ response: { ...response(), content } }), invalid)
})

test('rejects circular tool input without swallowing the failure', async () => {
  const input: Record<string, unknown> = {}
  input.self = input
  await assert.rejects(generate({ response: { ...response(), toolCalls: [{ id: 'call', name: 'tool', input }] } }), invalid)
})

test('accepts shared non-circular content and JSON array tool input', async () => {
  const content = [{ type: 'text', text: 'shared' }]
  const value = { ...response(), content: [
    { type: 'tool_result', toolResult: { toolUseId: 'one', content } },
    { type: 'tool_result', toolResult: { toolUseId: 'two', content } }
  ], toolCalls: [{ id: 'call', name: 'tool', input: [1, null, {}] }] }
  assert.equal((await generate({ response: value })).response, value)
})

const invalidRequests: Record<string, unknown> = {
  'null message': { messages: [null] },
  'invalid message role': { messages: [{ role: 'bogus', content: '' }] },
  'invalid message content': { messages: [{ role: 'user', content: 42 }] },
  'invalid message metadata': { messages: [{ role: 'tool', content: '', meta: { toolCallId: 42 } }] },
  'invalid nested request tool signature': { messages: [{ role: 'assistant', content: '', meta: { toolCalls: [{ id: 'call', name: 'tool', input: {}, thoughtSignature: 42 }] } }] },
  'invalid config number': { config: { maxTokens: '10' } },
  'invalid stop': { config: { stop: [42] } },
  'invalid thinking': { config: { thinking: { enabled: 'yes' } } },
  'invalid output schema': { config: { outputFormat: { type: 'json_schema', schema: null } } },
  'invalid tools': { tools: [{ name: 'tool', description: 'test', parameters: null }] },
  'invalid tool choice': { toolChoice: { name: 42 } }
}
for (const [name, fields] of Object.entries(invalidRequests)) {
  test(`rejects replacement request: ${name}`, async () => {
    await assert.rejects(generate({ ...request(), ...fields as object }), invalid)
  })
}

test('preserves valid image, nested tool results, signatures and logprobs', async () => {
  const value = { ...response(), content: [
    { type: 'image', imageBase64: 'aA==', imageMediaType: 'image/png' },
    { type: 'tool_result', toolResult: { toolUseId: 'call', isError: false, content: [
      { type: 'image', imageUrl: 'https://example.test/image' }, { type: 'text', text: '' }
    ] } },
    { type: 'thinking', thinking: 'reasoning', signature: '', reasoningKind: 'raw' },
    { type: 'redacted_thinking', data: 'opaque', reasoningProvider: 'openai' },
    { type: 'tool_use', toolUse: { id: 'call', name: 'tool', input: { values: [null, true, 1] } } }
  ], toolCalls: [{ id: 'call', name: 'tool', input: {}, thoughtSignature: 'signed' }],
  logprobs: [{ token: 'a', logprob: -0.5, bytes: [97], top_logprobs: [{ token: 'b', logprob: -1, bytes: null }] }] }
  assert.equal((await generate({ response: value })).response, value)
})

test('preserves legacy requests, valid normalized config and empty response shorthand', async () => {
  const legacy = { ...request(), config: { reasoningEffort: 'high', reasoningSummary: 'auto', thinkingConfig: { thinkingBudget: -1, includeThoughts: true } } }
  assert.equal((await generate(legacy)).request, legacy)
  const normalized = { ...request(), tools: [{ name: 'tool', description: '', parameters: {} }], toolChoice: { name: 'tool' }, config: {
    maxTokens: 10, temperature: 0, topP: 1, stop: ['end'], systemPrompt: '', logprobs: true, topLogprobs: 1,
    thinking: { enabled: true, mode: 'adaptive', effort: 'xhigh', budgetTokens: 10, includeSummary: false, summary: 'auto' },
    outputFormat: { type: 'json_schema', schema: {}, strict: null, schemaDialect: 'gemini' }
  } }
  assert.equal((await generate(normalized)).request, normalized)
  assert.ok((await generate({ response: '' })).response)
  assert.ok((await generate(undefined)).request)
})
