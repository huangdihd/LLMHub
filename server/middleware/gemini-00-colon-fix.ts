export default defineEventHandler((event) => {
  const url = event.node.req.url || ''
  if (url.includes(':generateContent')) {
    event.node.req.url = url.replace(':generateContent', '/generateContent')
  } else if (url.includes(':streamGenerateContent')) {
    event.node.req.url = url.replace(':streamGenerateContent', '/streamGenerateContent')
  }
})
