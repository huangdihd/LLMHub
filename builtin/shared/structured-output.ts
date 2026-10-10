import type { OutputFormat } from '../../server/core/types'

function invalid(message: string): never {
  throw Object.assign(new Error(`Structured output: ${message}`), { statusCode: 400, _statusCode: 400, _source: 'gateway' })
}

function schemaFormat(value: any): Extract<OutputFormat, { type: 'json_schema' }> {
  if (!value || typeof value.schema !== 'object' || value.schema === null || Array.isArray(value.schema)) {
    invalid('json_schema requires a schema object')
  }
  if (value.strict != null && typeof value.strict !== 'boolean') invalid('strict must be a boolean or null')
  if (value.name !== undefined && (typeof value.name !== 'string' || !value.name)) invalid('name must be a nonempty string')
  if (value.description !== undefined && typeof value.description !== 'string') invalid('description must be a string')
  return {
    type: 'json_schema', schema: value.schema,
    ...(value.name !== undefined ? { name: value.name } : {}),
    ...(value.description !== undefined ? { description: value.description } : {}),
    ...(value.strict !== undefined ? { strict: value.strict } : {})
  }
}

export function parseResponsesFormat(value: any): OutputFormat | undefined {
  if (value === undefined) return undefined
  if (value?.type === 'text' || value?.type === 'json_object') return { type: value.type }
  if (value?.type === 'json_schema') return schemaFormat(value)
  return invalid('unsupported text.format type')
}

export function parseChatResponseFormat(value: any): OutputFormat | undefined {
  if (value?.type === 'json_schema') return schemaFormat(value.json_schema)
  return parseResponsesFormat(value)
}

export function parseClaudeOutputFormat(value: any): OutputFormat | undefined {
  if (value === undefined) return undefined
  if (value?.type !== 'json_schema') return invalid('Claude output_config.format must use json_schema')
  return schemaFormat(value)
}

export function parseGeminiOutputConfig(config: any): OutputFormat | undefined {
  const { responseMimeType: mime, responseSchema, responseJsonSchema } = config
  if (responseSchema !== undefined && responseJsonSchema !== undefined) invalid('responseSchema and responseJsonSchema are mutually exclusive')
  const schema = responseSchema !== undefined ? responseSchema : responseJsonSchema
  if (schema !== undefined) {
    if (mime !== 'application/json') invalid('Gemini response schemas require application/json')
    return { ...schemaFormat({ schema }), schemaDialect: responseSchema !== undefined ? 'gemini' : 'json_schema' }
  }
  if (mime === undefined) return undefined
  if (mime === 'text/plain') return { type: 'text' }
  if (mime === 'application/json') return { type: 'json_object' }
  return invalid(`unsupported response MIME type ${mime}`)
}

export function toResponsesFormat(format?: OutputFormat): any {
  if (!format) return undefined
  if (format.type !== 'json_schema') return { type: format.type }
  if (format.schemaDialect === 'gemini') invalid('Gemini responseSchema cannot be losslessly converted to OpenAI JSON Schema; use responseJsonSchema')
  const { schemaDialect, ...value } = format
  return { ...value, name: format.name ?? 'structured_output' }
}

export function toChatResponseFormat(format?: OutputFormat): any {
  const value = toResponsesFormat(format)
  if (value?.type !== 'json_schema') return value
  const { type, ...json_schema } = value
  return { type, json_schema }
}

export function toClaudeOutputFormat(format?: OutputFormat): any {
  if (!format || format.type === 'text') return undefined
  if (format.type === 'json_object') invalid('Claude does not support schema-less JSON mode')
  if (format.schemaDialect === 'gemini') invalid('Gemini responseSchema cannot be losslessly converted to Claude JSON Schema')
  if (format.strict != null) invalid('Claude cannot preserve an explicit OpenAI strict flag')
  return { type: 'json_schema', schema: format.schema }
}

export function toGeminiOutputConfig(format?: OutputFormat): any {
  if (!format) return undefined
  if (format.type === 'text') return { responseMimeType: 'text/plain' }
  if (format.type === 'json_object') return { responseMimeType: 'application/json' }
  if (format.strict != null) invalid('Gemini cannot preserve an explicit OpenAI strict flag')
  return { responseMimeType: 'application/json', [format.schemaDialect === 'gemini' ? 'responseSchema' : 'responseJsonSchema']: format.schema }
}

export function assertNoStructuredOutput(format: OutputFormat | undefined, provider: string): void {
  if (format && format.type !== 'text') invalid(`${provider} does not support structured output`)
}
