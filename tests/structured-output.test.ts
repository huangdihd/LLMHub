import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { OpenAIResponsesParser } from '../server/protocols/openai-responses.ts'
import { OpenAIChatParser } from '../server/protocols/openai-chat.ts'
import { ClaudeMessagesParser } from '../server/protocols/claude-messages.ts'
import { OpenAIResponsesSerializer } from '../server/protocols/openai-responses-serializer.ts'
import { toResponsesFormat, toChatResponseFormat, toClaudeOutputFormat, toGeminiOutputConfig, parseGeminiOutputConfig } from '../server/utils/structured-output.ts'

const schema = { type: 'object', properties: { memory_ids: { type: 'array', items: { type: 'string' } } }, required: ['memory_ids'], additionalProperties: false }
const format = { type: 'json_schema' as const, name: 'memory_selection', description: 'Selected memories', strict: true, schema }
const badRequest = (error: any) => error.statusCode === 400 && error._statusCode === 400

for (const stream of [false, true]) {
  test(`Responses structured output preserves full contract (stream=${stream})`, () => {
    const request = new OpenAIResponsesParser().parseRequest({ input: 'select memories', stream, text: { format }, reasoning: { effort: 'low' } })
    assert.deepEqual(request.config.outputFormat, format)
    assert.equal(request.config.thinking?.effort, 'low')
    assert.deepEqual(toResponsesFormat(request.config.outputFormat), format)
    assert.deepEqual(toChatResponseFormat(request.config.outputFormat), { type: 'json_schema', json_schema: { name: format.name, description: format.description, strict: true, schema } })
    const serializer = new OpenAIResponsesSerializer(request.config.outputFormat)
    assert.deepEqual(serializer.serializeResponse({ content: '{}', finishReason: 'stop' }).text.format, format)
    const events = [...serializer.startEvents(), ...serializer.serializeStreamChunk({ type: 'done', finishReason: 'stop' })]
    for (const event of events.filter(e => e.data.response)) assert.deepEqual(event.data.response.text.format, format)
  })
}

test('Chat parses nested schema and preserves false/null strict', () => {
  for (const strict of [false, null, undefined]) {
    const json_schema = { name: 'result', schema, ...(strict !== undefined ? { strict } : {}) }
    const request = new OpenAIChatParser().parseRequest({ messages: [], response_format: { type: 'json_schema', json_schema } })
    assert.deepEqual(toChatResponseFormat(request.config.outputFormat), { type: 'json_schema', json_schema })
  }
})

test('Claude format and effort coexist; native schema maps without alteration', () => {
  const request = new ClaudeMessagesParser().parseRequest({ messages: [], output_config: { effort: 'high', format: { type: 'json_schema', schema } } })
  assert.equal(request.config.thinking?.effort, 'high')
  assert.deepEqual(toClaudeOutputFormat(request.config.outputFormat), { type: 'json_schema', schema })
  assert.deepEqual(toResponsesFormat(request.config.outputFormat), { type: 'json_schema', schema, name: 'structured_output' })
})

test('Gemini native schema dialects and JSON mode round-trip', () => {
  const require = createRequire(import.meta.url)
  assert.ok(process.env.ADAPTER_BUILD, 'run via npm test')
  const { GeminiGenerateParser } = require(`${process.env.ADAPTER_BUILD}/protocols/gemini-generate.js`)
  for (const field of ['responseSchema', 'responseJsonSchema']) {
    const generationConfig = { responseMimeType: 'application/json', [field]: schema }
    const request = new GeminiGenerateParser().parseRequest({ contents: [], generationConfig })
    assert.deepEqual(toGeminiOutputConfig(request.config.outputFormat), generationConfig)
  }
  assert.deepEqual(toGeminiOutputConfig(parseGeminiOutputConfig({ responseMimeType: 'application/json' })), { responseMimeType: 'application/json' })
})

test('missing formats and explicit text retain default behavior', () => {
  const request = new OpenAIResponsesParser().parseRequest({ input: '' })
  assert.equal(request.config.outputFormat, undefined)
  assert.equal(toChatResponseFormat(undefined), undefined)
  assert.deepEqual(new OpenAIResponsesSerializer().serializeResponse({ content: '', finishReason: 'stop' }).text.format, { type: 'text' })
  assert.deepEqual(toResponsesFormat({ type: 'text' }), { type: 'text' })
  assert.deepEqual(toChatResponseFormat({ type: 'json_object' }), { type: 'json_object' })
})

test('invalid formats and incompatible contracts explicitly fail with 400', () => {
  const responses = new OpenAIResponsesParser()
  for (const value of [null, { type: 'xml' }, { type: 'json_schema' }, { ...format, strict: 'true' }]) {
    assert.throws(() => responses.parseRequest({ input: '', text: { format: value } }), badRequest)
  }
  for (const config of [{ responseMimeType: 'text/x.enum' }, { responseSchema: schema }, { responseMimeType: 'application/json', responseSchema: schema, responseJsonSchema: schema }]) {
    assert.throws(() => parseGeminiOutputConfig(config), badRequest)
  }
  assert.throws(() => toClaudeOutputFormat(format), badRequest)
  assert.throws(() => toGeminiOutputConfig(format), badRequest)
  assert.throws(() => toClaudeOutputFormat({ type: 'json_object' }), badRequest)
  const gemini = parseGeminiOutputConfig({ responseMimeType: 'application/json', responseSchema: schema })
  assert.throws(() => toResponsesFormat(gemini), badRequest)
  assert.throws(() => toChatResponseFormat(gemini), badRequest)
  assert.throws(() => toClaudeOutputFormat(gemini), badRequest)
})
