const GEMINI_SUPPORTED_SCHEMA_KEYS = new Set([
  'type', 'properties', 'required', 'description', 'enum', 'items', 'nullable'
])

export function sanitizeGeminiSchema(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(sanitizeGeminiSchema)
  const cleaned: any = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!GEMINI_SUPPORTED_SCHEMA_KEYS.has(k)) continue
    cleaned[k] = sanitizeGeminiSchema(v)
  }
  return cleaned
}
