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

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', async () => {
    try {
      const u = new URL(req.url, 'http://mock')
      let protocol, scenario, kind

      if (u.pathname === '/openai/chat/completions') {
        const body = JSON.parse(raw || '{}')
        protocol = 'openai'
        scenario = body.model
        kind = body.stream ? 'stream' : 'sync'
      } else if (u.pathname === '/claude/v1/messages') {
        const body = JSON.parse(raw || '{}')
        protocol = 'claude'
        scenario = body.model
        kind = body.stream ? 'stream' : 'sync'
      } else {
        const m = u.pathname.match(/^\/gemini\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/)
        if (!m) return notFound(res, `unknown path: ${u.pathname}`)
        protocol = 'gemini'
        scenario = decodeURIComponent(m[1])
        kind = m[2] === 'streamGenerateContent' ? 'stream' : 'sync'
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
