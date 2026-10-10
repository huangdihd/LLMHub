/**
 * 从 Gemini content 对象中提取文本（拼接所有 parts.text）。
 */
export function geminiContentToText(content: any): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  const parts = content.parts || []
  return parts.map((p: any) => p?.text || '').join('')
}
