import { getHeader, createError } from 'h3'
import type { H3Event } from 'h3'

export function requireAuth(event: H3Event): void {
  // 读取环境变量
  const validKeys = process.env.LLMHUB_API_KEYS

  // 未配置则跳过鉴权（向后兼容）
  if (!validKeys) return

  // 解析逗号分隔的 key 列表
  const keys = validKeys.split(',').map(k => k.trim()).filter(Boolean)
  if (keys.length === 0) return

  // 从请求头提取 key
  const authHeader = getHeader(event, 'Authorization')
  const apiKeyHeader = getHeader(event, 'X-API-Key')

  let providedKey = ''
  if (authHeader?.startsWith('Bearer ')) {
    providedKey = authHeader.slice(7).trim()
  } else if (apiKeyHeader) {
    providedKey = apiKeyHeader.trim()
  }

  // 验证
  if (!providedKey || !keys.includes(providedKey)) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthorized',
      data: {
        error: {
          message: 'Invalid API Key. Please provide a valid API key via Authorization: Bearer <key> or X-API-Key header.',
          type: 'authentication_error',
          code: 'invalid_api_key'
        }
      }
    })
  }
}