import assert from 'node:assert/strict'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

// Run against a freshly built gateway: GATEWAY_URL=http://127.0.0.1:3999 node tests/e2e/plugin-dependencies.test.mjs
const gateway = process.env.GATEWAY_URL || 'http://127.0.0.1:3999'
const session = randomUUID()
const sessionFile = new URL(`../../.data/auth/sessions/${session}`, import.meta.url)
const suffix = session.slice(0, 8)
const provider = `dependency-${suffix}`
const consumer = `dependent-${suffix}`
const installed = new Set()

async function request(path, options = {}) {
  return fetch(`${gateway}/api/hub/plugins${path}`, {
    ...options, headers: { cookie: `llmhub_session=${session}`, ...options.headers }
  })
}
async function list() {
  const response = await request('')
  assert.equal(response.status, 200)
  return response.json()
}
async function upload(id, version, extra = {}, force) {
  const body = new FormData()
  const manifest = { id, name: id, version, engines: { llmhub: '^1.0.0' }, ...extra }
  const setup = id === provider
    ? `api.provide({ value: ${JSON.stringify(version)} });`
    : `const service = api.require(${JSON.stringify(provider)}); api.registerRoute('GET', 'value', () => ({ value: service.value }));`
  body.set('file', new Blob([`export const manifest = ${JSON.stringify(manifest)};\nexport default { setup(api) { ${setup} } }\n`]), `${id}.mjs`)
  if (force !== undefined) body.set('force', force)
  const response = await request('/install', { method: 'POST', body })
  if (response.ok) installed.add(id)
  return response
}

try {
  await mkdir(new URL('../../.data/auth/sessions/', import.meta.url), { recursive: true })
  await writeFile(sessionFile, JSON.stringify({ expires_at: Date.now() + 300_000 }))
  const before = await list()
  assert.ok(!before.some(plugin => [provider, consumer].includes(plugin.id)))
  for (const plugin of before) assert.equal(plugin.apiVersion, '1.0.0')
  assert.equal((await upload(provider, '1.0.0')).status, 200)
  assert.equal((await request(`/${provider}/enable`, { method: 'POST' })).status, 200)
  assert.equal((await upload(provider, '1.1.0')).status, 200)
  assert.equal((await upload(provider, '1.0.0', {}, 'false')).status, 400)
  assert.equal((await list()).find(plugin => plugin.id === provider).manifest.version, '1.1.0')
  assert.equal((await upload(provider, '1.0.0', {}, 'yes')).status, 400)
  assert.equal((await upload(provider, '1.0.0', {}, 'true')).status, 200)
  assert.equal((await upload(consumer, '1.0.0', { dependencies: { [provider]: '^1.0.0' } })).status, 200)
  assert.equal((await request(`/${consumer}/enable`, { method: 'POST' })).status, 200)
  const records = await list()
  assert.ok(records.find(plugin => plugin.id === provider).requiredBy.includes(consumer))
  const dependency = records.find(plugin => plugin.id === consumer).dependencies.find(item => item.id === provider)
  assert.equal(dependency.satisfied, true)
  assert.equal(dependency.version, '1.0.0')
  assert.equal((await request(`/${provider}/disable`, { method: 'POST' })).status, 400)
  assert.equal((await request(`/${provider}`, { method: 'DELETE' })).status, 400)
  assert.deepEqual(await (await request(`/${consumer}/api/value`)).json(), { value: '1.0.0' })
  assert.equal((await upload(provider, '1.2.0')).status, 200)
  assert.deepEqual(await (await request(`/${consumer}/api/value`)).json(), { value: '1.2.0' })
  assert.equal((await list()).find(plugin => plugin.id === consumer).enabled, true)
  console.log('ok - API version, upgrades, explicit force, dependency exports, dependent reload and removal guards')
} finally {
  try {
    for (const id of [consumer, provider]) {
      if (!installed.has(id)) continue
      const response = await request(`/${id}`, { method: 'DELETE' })
      assert.equal(response.status, 200, `Cleanup failed for ${id}: ${await response.text()}`)
    }
  } finally { await rm(sessionFile, { force: true }) }
}
