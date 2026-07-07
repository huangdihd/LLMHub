// Records real upstream behavior (raw SSE framing included) into
// tests/e2e/recordings/, for use as mock-server fixtures in CI.
//
// Usage: NODE_USE_ENV_PROXY=1 node tests/e2e/record-upstream.mjs
// Reads provider credentials from .data/providers/ — recordings themselves
// contain NO credentials (request headers are never persisted).
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const OUT_DIR = path.join(ROOT, 'tests/e2e/recordings')

const providers = {}
for (const name of ['deepseek', 'mimo_claude', 'Gemini']) {
  providers[name] = JSON.parse(fs.readFileSync(path.join(ROOT, '.data/providers', name), 'utf8'))
}

const WEATHER_TOOL_DESC = 'Get the current weather for a city'
const WEATHER_PARAMS = {
  type: 'object',
  properties: { city: { type: 'string', description: 'City name' } },
  required: ['city']
}

// ---------------------------------------------------------------------------
// scenario table: [protocol, scenario, kind, buildRequest()]
// ---------------------------------------------------------------------------
const openaiBase = { temperature: 0 }
const scenarios = [
  // ===== OpenAI protocol (deepseek) =====
  ['openai', 'text', 'sync', () => ({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
    max_tokens: 50, ...openaiBase
  })],
  ['openai', 'text', 'stream', () => ({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
    max_tokens: 50, stream: true, stream_options: { include_usage: true }, ...openaiBase
  })],
  ['openai', 'tool-call', 'sync', () => ({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'What is the weather in Beijing right now? Use the tool.' }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: WEATHER_TOOL_DESC, parameters: WEATHER_PARAMS } }],
    max_tokens: 200, ...openaiBase
  })],
  ['openai', 'tool-call', 'stream', () => ({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'What is the weather in Beijing right now? Use the tool.' }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: WEATHER_TOOL_DESC, parameters: WEATHER_PARAMS } }],
    max_tokens: 200, stream: true, stream_options: { include_usage: true }, ...openaiBase
  })],
  ['openai', 'truncated', 'sync', () => ({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'Count from 1 to 100, one number per line.' }],
    max_tokens: 8, ...openaiBase
  })],
  ['openai', 'truncated', 'stream', () => ({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'Count from 1 to 100, one number per line.' }],
    max_tokens: 8, stream: true, stream_options: { include_usage: true }, ...openaiBase
  })],
  ['openai', 'reasoning', 'stream', () => ({
    model: 'deepseek-reasoner',
    messages: [{ role: 'user', content: 'What is 17 + 25? Answer with just the number.' }],
    max_tokens: 2000, stream: true, stream_options: { include_usage: true }
  })],

  // ===== Claude protocol (mimo_claude) =====
  ['claude', 'text', 'sync', () => ({
    model: 'mimo-v2.5',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Say hello in one short sentence.' }]
  })],
  ['claude', 'text', 'stream', () => ({
    model: 'mimo-v2.5',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
    stream: true
  })],
  ['claude', 'tool-call', 'sync', () => ({
    model: 'mimo-v2.5',
    max_tokens: 300,
    messages: [{ role: 'user', content: 'What is the weather in Beijing right now? Use the tool.' }],
    tools: [{ name: 'get_weather', description: WEATHER_TOOL_DESC, input_schema: WEATHER_PARAMS }]
  })],
  ['claude', 'tool-call', 'stream', () => ({
    model: 'mimo-v2.5',
    max_tokens: 300,
    messages: [{ role: 'user', content: 'What is the weather in Beijing right now? Use the tool.' }],
    tools: [{ name: 'get_weather', description: WEATHER_TOOL_DESC, input_schema: WEATHER_PARAMS }],
    stream: true
  })],
  ['claude', 'truncated', 'sync', () => ({
    model: 'mimo-v2.5',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'Count from 1 to 100, one number per line.' }]
  })],
  ['claude', 'truncated', 'stream', () => ({
    model: 'mimo-v2.5',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'Count from 1 to 100, one number per line.' }],
    stream: true
  })],

  // ===== Gemini protocol =====
  ['gemini', 'text', 'sync', () => ({
    contents: [{ role: 'user', parts: [{ text: 'Say hello in one short sentence.' }] }],
    generationConfig: { maxOutputTokens: 64, temperature: 0, thinkingConfig: { thinkingBudget: 0 } }
  })],
  ['gemini', 'text', 'stream', () => ({
    contents: [{ role: 'user', parts: [{ text: 'Say hello in one short sentence.' }] }],
    generationConfig: { maxOutputTokens: 64, temperature: 0, thinkingConfig: { thinkingBudget: 0 } }
  })],
  ['gemini', 'tool-call', 'sync', () => ({
    contents: [{ role: 'user', parts: [{ text: 'What is the weather in Beijing right now? Use the tool.' }] }],
    tools: [{ functionDeclarations: [{ name: 'get_weather', description: WEATHER_TOOL_DESC, parameters: WEATHER_PARAMS }] }],
    generationConfig: { maxOutputTokens: 300, temperature: 0, thinkingConfig: { thinkingBudget: 0 } }
  })],
  ['gemini', 'tool-call', 'stream', () => ({
    contents: [{ role: 'user', parts: [{ text: 'What is the weather in Beijing right now? Use the tool.' }] }],
    tools: [{ functionDeclarations: [{ name: 'get_weather', description: WEATHER_TOOL_DESC, parameters: WEATHER_PARAMS }] }],
    generationConfig: { maxOutputTokens: 300, temperature: 0, thinkingConfig: { thinkingBudget: 0 } }
  })],
  ['gemini', 'truncated', 'sync', () => ({
    contents: [{ role: 'user', parts: [{ text: 'Count from 1 to 100, one number per line.' }] }],
    generationConfig: { maxOutputTokens: 8, temperature: 0, thinkingConfig: { thinkingBudget: 0 } }
  })],
  ['gemini', 'truncated', 'stream', () => ({
    contents: [{ role: 'user', parts: [{ text: 'Count from 1 to 100, one number per line.' }] }],
    generationConfig: { maxOutputTokens: 8, temperature: 0, thinkingConfig: { thinkingBudget: 0 } }
  })]
]

// ---------------------------------------------------------------------------
function buildCall(protocol, kind, body) {
  if (protocol === 'openai') {
    const c = providers.deepseek.connection
    return {
      url: `${c.base_url}/chat/completions`,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${c.api_key}` },
      provider: 'deepseek'
    }
  }
  if (protocol === 'claude') {
    const c = providers.mimo_claude.connection
    return {
      url: `${c.base_url}/v1/messages`,
      headers: { 'Content-Type': 'application/json', 'x-api-key': c.api_key, 'anthropic-version': c.version || '2023-06-01' },
      provider: 'mimo_claude'
    }
  }
  // gemini
  const c = providers.Gemini.connection
  const model = 'gemini-2.5-flash-lite'
  const action = kind === 'stream' ? 'streamGenerateContent?alt=sse' : 'generateContent'
  return {
    url: `${c.base_url}/v1beta/models/${model}:${action}`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.api_key },
    provider: 'Gemini',
    model
  }
}

async function record(protocol, scenario, kind, body) {
  const call = buildCall(protocol, kind, body)
  const started = Date.now()
  const res = await fetch(call.url, {
    method: 'POST',
    headers: call.headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  })

  const meta = {
    provider: call.provider,
    protocol,
    scenario,
    kind,
    model: body.model || call.model,
    url_path: new URL(call.url).pathname + new URL(call.url).search,
    recorded_at: new Date().toISOString(),
    request_body: body
  }

  const out = { meta, status: res.status, content_type: res.headers.get('content-type') }

  if (kind === 'sync' || res.status !== 200) {
    const text = await res.text()
    try { out.body = JSON.parse(text) } catch { out.body_text = text }
  } else {
    // Preserve the exact bytes AND the chunk boundaries as they arrived
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const chunks = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(decoder.decode(value, { stream: true }))
    }
    out.raw_chunks = chunks
    out.raw_sse = chunks.join('')
    // Parsed view for humans; the mock replays raw_chunks
    out.events = out.raw_sse.split('\n')
      .filter(l => l.startsWith('data: ') && l.slice(6).trim() && l.slice(6).trim() !== '[DONE]')
      .map(l => { try { return JSON.parse(l.slice(6)) } catch { return { _unparsed: l } } })
  }

  out.duration_ms = Date.now() - started

  const dir = path.join(OUT_DIR, protocol)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${scenario}-${kind}.json`)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  return { file, status: res.status, size: kind === 'sync' ? undefined : out.raw_sse?.length }
}

let ok = 0, fail = 0
for (const [protocol, scenario, kind, build] of scenarios) {
  const label = `${protocol}/${scenario}-${kind}`
  try {
    const r = await record(protocol, scenario, kind, build())
    const note = r.status === 200 ? 'ok' : `HTTP ${r.status}`
    console.log(`${r.status === 200 ? '✓' : '✗'} ${label.padEnd(28)} ${note}${r.size ? ` (sse ${r.size}B)` : ''}`)
    r.status === 200 ? ok++ : fail++
  } catch (e) {
    console.log(`✗ ${label.padEnd(28)} ${e.cause?.code || e.message}`)
    fail++
  }
}
console.log(`\n${ok} recorded, ${fail} failed → ${OUT_DIR}`)
if (fail > 0) process.exitCode = 1
