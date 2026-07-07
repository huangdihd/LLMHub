// Seeds (or removes) e2e fixtures in .data: three mock providers + one API key.
// Everything it creates is namespaced with "_e2e" so it coexists with real
// local data and can be removed precisely.
//
// Usage: node tests/e2e/seed.mjs seed|cleanup
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = path.resolve(import.meta.dirname, '../..')
const DATA = path.join(ROOT, '.data')
const MOCK_PORT = Number(process.env.MOCK_PORT || 4000)

export const E2E_API_KEY = 'llmhub-e2e-test-key'
const E2E_KEY_ID = '_e2e-key'

const MODELS = ['text', 'tool-call', 'truncated', 'reasoning', 'no-done']
  .map(id => ({ id, display_name: `mock ${id}`, capabilities: { tools: true, streaming: true } }))

const providerConfigs = [
  { name: '_e2e-openai', protocol: 'openai', base: 'openai' },
  { name: '_e2e-claude', protocol: 'claude', base: 'claude' },
  { name: '_e2e-gemini', protocol: 'gemini', base: 'gemini' }
].map(p => ({
  name: p.name,
  display_name: `E2E mock (${p.protocol})`,
  protocol: p.protocol,
  enabled: true,
  use_custom_models: true,
  connection: {
    api_key: 'mock-key',
    base_url: `http://127.0.0.1:${MOCK_PORT}/${p.base}`,
    timeout: 15000,
    enable_timeout: true,
    max_retries: 0
  },
  models: MODELS
}))

const keysFile = path.join(DATA, 'auth', 'api-keys')

function readKeys() {
  try { return JSON.parse(fs.readFileSync(keysFile, 'utf8')) } catch { return [] }
}

function seed() {
  fs.mkdirSync(path.join(DATA, 'providers'), { recursive: true })
  fs.mkdirSync(path.join(DATA, 'auth'), { recursive: true })

  for (const cfg of providerConfigs) {
    fs.writeFileSync(path.join(DATA, 'providers', cfg.name), JSON.stringify(cfg, null, 2))
  }

  const keys = readKeys().filter(k => k.id !== E2E_KEY_ID)
  keys.push({
    id: E2E_KEY_ID,
    name: '_e2e',
    hash: crypto.createHash('sha256').update(E2E_API_KEY).digest('hex'),
    allowed_providers: [],
    allowed_models: [],
    monthly_limit: 0,
    tokens_used: 0,
    current_month: new Date().toISOString().slice(0, 7),
    call_count: 0,
    created_at: new Date().toISOString(),
    model_quotas: {},
    model_usage: {},
    provider_quotas: {},
    provider_usage: {},
    fallback_strategy: { enabled: false, name: 'auto', priority: [] }
  })
  fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2))
  console.log('[seed] created 3 _e2e providers and the _e2e api key')
}

function cleanup() {
  for (const cfg of providerConfigs) {
    fs.rmSync(path.join(DATA, 'providers', cfg.name), { force: true })
  }
  if (fs.existsSync(keysFile)) {
    const keys = readKeys().filter(k => k.id !== E2E_KEY_ID)
    fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2))
  }
  console.log('[seed] removed _e2e fixtures')
}

const cmd = process.argv[2]
if (cmd === 'seed') seed()
else if (cmd === 'cleanup') cleanup()
else { console.error('usage: node tests/e2e/seed.mjs seed|cleanup'); process.exit(1) }
