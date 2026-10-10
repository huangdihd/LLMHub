import type { ContentBlock } from '../../server/core/types'

const PREFIX = 'llmhub:thinking:v1:'

function invalidState(): never {
  throw Object.assign(new Error('Invalid LLMHub thinking state'), {
    statusCode: 400, _statusCode: 400, _source: 'gateway'
  })
}

// This is a transport envelope, not encryption or authentication. Upstream validates signatures.
export function encodeThinkingState(blocks: ContentBlock[]): string {
  return PREFIX + Buffer.from(JSON.stringify(blocks.map(block => ({
    thinking: block.thinking || '', signature: block.signature
  })))).toString('base64url')
}

export function decodeThinkingState(value: unknown): ContentBlock[] | undefined {
  if (typeof value !== 'string' || !value.startsWith('llmhub:thinking:')) return undefined
  if (!value.startsWith(PREFIX)) return invalidState()
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value.slice(PREFIX.length), 'base64url').toString('utf8'))
  } catch {
    return invalidState()
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return invalidState()
  return parsed.map(block => {
    if (!block || typeof block.thinking !== 'string' || typeof block.signature !== 'string' || !block.signature) {
      return invalidState()
    }
    return { type: 'thinking', thinking: block.thinking, signature: block.signature }
  })
}
