import type { H3Event } from 'h3'

export default defineEventHandler(async (event: H3Event) => {
  const rawUrl = event.node.req.url || ''
  const questionIdx = rawUrl.indexOf('?')
  const pathname = questionIdx >= 0 ? rawUrl.slice(0, questionIdx) : rawUrl
  const query = questionIdx >= 0 ? rawUrl.slice(questionIdx) : ''

  if (pathname.startsWith('/api/gemini/v1beta/')) {
    let newPath = pathname
      .replace('/api/gemini/v1beta/', '/api/gemini/v1/')
      .replace(':generateContent', '/generateContent')
      .replace(':streamGenerateContent', '/streamGenerateContent')
    event.node.req.url = newPath + query
    ;(event as any)._url = undefined
  }
})
