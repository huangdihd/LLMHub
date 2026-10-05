const GEMINI_SUPPORTED_SCHEMA_KEYS = new Set([
  'anyOf', 'default', 'description', 'enum', 'example', 'format',
  'items', 'maxItems', 'maxLength', 'maxProperties', 'maximum',
  'minItems', 'minLength', 'minProperties', 'minimum',
  'nullable', 'pattern', 'properties', 'propertyOrdering',
  'required', 'title', 'type'
])

export function sanitizeGeminiSchema(obj: any, isProperties: boolean = false): any {
  if (!obj || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map((x: any) => sanitizeGeminiSchema(x))
  const cleaned: any = {}
  for (const [k, v] of Object.entries(obj)) {
    // Inside properties, pass through all property names (command, description, prompt, etc.)
    // At schema level, only keep supported JSON Schema keywords
    if (!isProperties && !GEMINI_SUPPORTED_SCHEMA_KEYS.has(k)) continue
    cleaned[k] = sanitizeGeminiSchema(v, k === 'properties')
  }
  if (!isProperties && Array.isArray(cleaned.type)) {
    const types: unknown[] = [...new Set(cleaned.type)]
    const nonNullTypes = types.filter(type => type !== 'null')
    // Google Schema uses a scalar type and nullable, not JSON Schema type arrays.
    // Reject unions we cannot represent here rather than silently narrowing them.
    if (nonNullTypes.length !== 1 || typeof nonNullTypes[0] !== 'string' ||
        !['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(nonNullTypes[0])) {
      throw Object.assign(new Error('Gemini tool schema: type arrays must contain one non-null type, optionally with null'), {
        statusCode: 400, _statusCode: 400, _source: 'gateway'
      })
    }
    cleaned.type = nonNullTypes[0]
    if (types.includes('null')) cleaned.nullable = true
  }
  // Strip required entries that reference properties that no longer exist
  if (cleaned.required && cleaned.properties && Array.isArray(cleaned.required)) {
    const validProps = new Set(Object.keys(cleaned.properties))
    cleaned.required = cleaned.required.filter((name: string) => validProps.has(name))
    if (cleaned.required.length === 0) delete cleaned.required
  }
  return cleaned
}
