import type { H3Event } from 'h3'

export default defineEventHandler(async (event: H3Event) => {
  const url = event.path
  
  if (url.startsWith('/api/gemini/v1beta/')) {
    let newUrl = url.replace('/api/gemini/v1beta/', '/api/gemini/v1/')
    newUrl = newUrl.replace(':generateContent', '/generateContent')
    newUrl = newUrl.replace(':streamGenerateContent', '/streamGenerateContent')
    
    const originalUrl = event.node.req.url || ''
    const queryIndex = originalUrl.indexOf('?')
    if (queryIndex >= 0) {
      newUrl += originalUrl.slice(queryIndex)
    }
    event.node.req.url = newUrl
  }
})
