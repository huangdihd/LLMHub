import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createRegistry } from './npm-registry.mjs'

try { execFileSync('npm', ['--version'], { stdio: 'ignore' }) }
catch { console.log('SKIP npm e2e: npm is not available'); process.exit(0) }
// Use a separate process and working directory: never move a live gateway's
// library tree or overwrite an operator's plugin project/state during tests.
const directory = await mkdtemp(join(tmpdir(), 'llmhub-e2e-npm-'))
const reservation = createServer()
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const gateway = `http://127.0.0.1:${port}`
const session = randomUUID()
const fixture = await createRegistry()
let child
let output = ''
async function request(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`${gateway}/api/hub/plugins${path}`, { method, headers: { cookie: `llmhub_session=${session}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  return result
}
try {
  await mkdir(join(directory, '.data/auth/sessions'), { recursive: true })
  // Enable the existing hub authentication gate in this isolated fixture.
  await writeFile(join(directory, '.data/auth/password'), JSON.stringify({ hash: 'unused-fixture-hash', salt: 'unused-fixture-salt' }))
  await writeFile(join(directory, '.data/auth/sessions', session), JSON.stringify({ expires_at: Date.now() + 300_000 }))
  child = spawn(process.execPath, [fileURLToPath(new URL('../../.output/server/index.mjs', import.meta.url))], {
    cwd: directory, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`Isolated gateway exited: ${output}`)
    try { await request(''); ready = true; break } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(ready, `Isolated gateway did not become ready: ${output}`)
  const capabilities = await request('/capabilities')
  assert.equal(capabilities.npm.available, true)
  await request('/registry', { registry: fixture.registry }, 'PUT')
  assert.equal((await request('/registry')).registry, `${fixture.registry}/`)
  const unauthorized = await fetch(`${gateway}/api/hub/plugins/market`)
  assert.equal(unauthorized.status, 401)
  // Production outbound policy rejects loopback even with its allowlist disabled.
  // Search/detail content is covered with the explicit local-registry test seam.
  const blockedMarket = await fetch(`${gateway}/api/hub/plugins/market`, { headers: { cookie: `llmhub_session=${session}` } })
  assert.equal(blockedMarket.status, 400)
  assert.equal((await blockedMarket.json()).data.code, 'REGISTRY_BLOCKED')
  const records = await request('/install-npm', { name: 'llmhub-plugin-npm-fixture', version: '1.0.0' })
  assert.ok(records.some(record => record.id === 'npm-fixture'))
  await request('/npm-fixture/enable', {})
  assert.deepEqual(await request('/npm-fixture/api/value'), { value: 'library-ok', version: '1.0.0' })
  const updates = await request('/npm-fixture/updates')
  assert.equal(updates.available, true)
  assert.equal(updates.latestVersion, '1.1.0')
  assert.equal(updates.latestMatchingVersion, '1.0.0')
  assert.ok(updates.updates.some(update => update.version === '1.1.0'))
  await request('/npm-fixture/update', { specification: { name: 'llmhub-plugin-npm-fixture', version: '1.1.0' } })
  assert.deepEqual(await request('/npm-fixture/api/value'), { value: 'library-upgraded', version: '1.1.0' })
  await assert.rejects(access(fixture.marker), { code: 'ENOENT' })
  await request('/npm-fixture', undefined, 'DELETE')
  assert.ok(!(await request('')).some(record => record.id === 'npm-fixture'))
  console.log('ok - real npm offline install, library import, ignored postinstall, updates, upgrade and uninstall')
} finally {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited }
  await fixture.close()
  await rm(directory, { recursive: true, force: true })
}
