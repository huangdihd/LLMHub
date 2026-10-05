import assert from 'node:assert/strict'
import { sanitizeGeminiSchema } from '../server/utils/sanitize-gemini-schema.ts'

const input = {
  type: 'object',
  properties: {
    type: { type: ['string', 'null'] },
    timeout: { type: ['integer', 'null'], minimum: 0 },
    nested: { type: 'array', items: { type: ['object', 'null'], properties: { value: { type: ['boolean', 'null'] } } } },
    choice: { anyOf: [{ type: ['number', 'null'] }, { type: 'string' }] }
  },
  required: ['type', 'timeout']
}
const snapshot = structuredClone(input)
const output = sanitizeGeminiSchema(input)
assert.deepEqual(output.properties.type, { type: 'string', nullable: true })
assert.deepEqual(output.properties.timeout, { type: 'integer', minimum: 0, nullable: true })
assert.equal(output.properties.nested.items.type, 'object')
assert.equal(output.properties.nested.items.nullable, true)
assert.deepEqual(output.properties.nested.items.properties.value, { type: 'boolean', nullable: true })
assert.deepEqual(output.properties.choice.anyOf[0], { type: 'number', nullable: true })
assert.deepEqual(output.required, ['type', 'timeout'])
assert.deepEqual(input, snapshot)
assert.deepEqual(sanitizeGeminiSchema({ type: ['string'] }), { type: 'string' })
assert.deepEqual(sanitizeGeminiSchema({ type: ['null', 'string', 'string'], nullable: false }), { type: 'string', nullable: true })
assert.deepEqual(sanitizeGeminiSchema({ type: 'string', nullable: false }), { type: 'string', nullable: false })
for (const type of [[], ['null'], ['string', 'integer'], ['invalid'], [42]]) {
  assert.throws(() => sanitizeGeminiSchema({ type }), (error: any) => {
    assert.equal(error.statusCode, 400)
    assert.equal(error._source, 'gateway')
    assert.match(error.message, /one non-null type/)
    return true
  })
}
console.log('ok - Gemini nullable type arrays, nesting, property names, immutability and rejected unions')
