import type { EmbeddingRequest } from '../core/types'

/**
 * 将 OpenAI embeddings 的 input 字段归一化为统一的数组形式。
 * 支持：string | string[] | number[] (单个 token 序列) | number[][]
 */
export function normalizeOpenAIInput(input: any): Array<string | number[]> {
  if (input == null) return []
  if (typeof input === 'string') return [input]
  if (Array.isArray(input)) {
    if (input.length === 0) return []
    // number[] —— 单个 token 序列
    if (typeof input[0] === 'number') return [input as number[]]
    // (string | number[])[]
    return input as Array<string | number[]>
  }
  return [String(input)]
}

/**
 * 将一个 float 向量编码为 OpenAI base64 格式（little-endian float32）。
 */
export function encodeEmbeddingBase64(values: number[]): string {
  const floats = new Float32Array(values)
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64')
}

/**
 * 从 Gemini content 对象中提取文本（拼接所有 parts.text）。
 */
export function geminiContentToText(content: any): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  const parts = content.parts || []
  return parts.map((p: any) => p?.text || '').join('')
}

/** 构造统一嵌入请求的便捷类型别名（仅用于可读性） */
export type { EmbeddingRequest }
