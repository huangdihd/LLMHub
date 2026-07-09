// Mock upstream that replays real recorded provider behavior (tests/e2e/recordings/).
// Speaks all three provider protocols, selected by path prefix:
//   /openai/chat/completions            (OpenAI protocol)
//   /claude/v1/messages                 (Claude protocol)
//   /gemini/v1beta/models/<m>:<action>  (Gemini protocol)
// The scenario is the model name (recordings: text / tool-call / truncated / reasoning),
// plus handwritten edge cases that cannot be recorded (no-done).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.env.MOCK_PORT || 4000)
const REC_DIR = path.resolve(import.meta.dirname, 'recordings')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function loadRecording(protocol, scenario, kind) {
  const file = path.join(REC_DIR, protocol, `${scenario}-${kind}.json`)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

async function serveStream(res, chunks) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  })
  for (const chunk of chunks) {
    res.write(chunk)
    await sleep(2) // preserve chunk boundaries as distinct network writes
  }
  res.end()
}

function serveSync(res, rec) {
  res.writeHead(rec.status, { 'Content-Type': rec.content_type || 'application/json' })
  res.end(JSON.stringify(rec.body))
}

function notFound(res, msg) {
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: msg, type: 'mock_not_found' } }))
}

function badRequest(res, msg) {
  res.writeHead(400, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: `mock validation failed: ${msg}`, type: 'mock_bad_request' } }))
}

// For tool-result scenarios the gateway must have translated the client's tool
// result into THIS upstream's wire format — validate it strictly so a broken
// transform fails the e2e test instead of silently replaying a canned answer.
function validateToolResultRequest(protocol, body) {
  if (protocol === 'openai') {
    const assistant = (body.messages || []).find(m => m.role === 'assistant' && m.tool_calls?.length)
    if (!assistant) return 'no assistant message with tool_calls'
    if (assistant.tool_calls[0].function?.name !== 'get_weather') return 'tool_calls[0] name mismatch'
    const toolMsg = (body.messages || []).find(m => m.role === 'tool')
    if (!toolMsg) return 'no role:"tool" message'
    if (!toolMsg.tool_call_id) return 'tool message missing tool_call_id'
    if (toolMsg.tool_call_id !== assistant.tool_calls[0].id) return 'tool_call_id does not match the assistant call'
    if (!toolMsg.content) return 'tool message missing content'
    return null
  }
  if (protocol === 'claude') {
    const assistant = (body.messages || []).find(m =>
      Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use'))
    if (!assistant) return 'no assistant message with a tool_use block'
    const toolUse = assistant.content.find(b => b.type === 'tool_use')
    if (toolUse.name !== 'get_weather') return 'tool_use name mismatch'
    const resultMsg = (body.messages || []).find(m =>
      Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'))
    if (!resultMsg) return 'no tool_result block'
    const result = resultMsg.content.find(b => b.type === 'tool_result')
    if (result.tool_use_id !== toolUse.id) return 'tool_result tool_use_id does not match tool_use id'
    return null
  }
  // gemini
  const modelTurn = (body.contents || []).find(c => c.parts?.some(p => p.functionCall))
  if (!modelTurn) return 'no functionCall part'
  const fc = modelTurn.parts.find(p => p.functionCall).functionCall
  if (fc.name !== 'get_weather') return 'functionCall name mismatch'
  const responseTurn = (body.contents || []).find(c => c.parts?.some(p => p.functionResponse))
  if (!responseTurn) return 'no functionResponse part'
  const fr = responseTurn.parts.find(p => p.functionResponse).functionResponse
  if (fr.name !== 'get_weather') return `functionResponse name is "${fr.name}", expected "get_weather"`
  if (!fr.response) return 'functionResponse missing response payload'
  return null
}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', async () => {
    try {
      const u = new URL(req.url, 'http://mock')
      let protocol, scenario, kind
      const body = raw ? JSON.parse(raw) : {}

      if (u.pathname === '/openai/chat/completions') {
        protocol = 'openai'
        scenario = body.model
        kind = body.stream ? 'stream' : 'sync'
      } else if (u.pathname === '/openai/embeddings') {
        protocol = 'openai'
        scenario = 'embeddings'
        kind = 'sync'
      } else if (u.pathname === '/claude/v1/messages') {
        protocol = 'claude'
        scenario = body.model
        kind = body.stream ? 'stream' : 'sync'
      } else {
        const m = u.pathname.match(/^\/gemini\/v1beta\/models\/(.+):(generateContent|streamGenerateContent|embedContent|batchEmbedContents)$/)
        if (!m) return notFound(res, `unknown path: ${u.pathname}`)
        protocol = 'gemini'
        scenario = decodeURIComponent(m[1])
        if (m[2] === 'embedContent' || m[2] === 'batchEmbedContents') {
          scenario = 'embeddings'
          kind = 'sync'
        } else {
          kind = m[2] === 'streamGenerateContent' ? 'stream' : 'sync'
        }
      }

      if (scenario === 'tool-result') {
        const problem = validateToolResultRequest(protocol, body)
        if (problem) return badRequest(res, `${protocol} tool-result request: ${problem}`)
      }

      // Handwritten edge case: upstream closes the stream without sending [DONE]
      if (scenario === 'no-done') {
        const rec = loadRecording(protocol, 'text', 'stream')
        if (!rec) return notFound(res, 'base recording missing for no-done')
        const chunks = rec.raw_chunks
          .map(c => c.replace(/data: \[DONE\]\n\n?/g, ''))
          .filter(c => c.length > 0)
        return serveStream(res, chunks)
      }

      const rec = loadRecording(protocol, scenario, kind)
      if (!rec) return notFound(res, `no recording: ${protocol}/${scenario}-${kind}`)

      if (kind === 'stream') return serveStream(res, rec.raw_chunks)
      return serveSync(res, rec)
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `mock error: ${e.message}` } }))
    }
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-upstream] listening on http://127.0.0.1:${PORT}`)
})
