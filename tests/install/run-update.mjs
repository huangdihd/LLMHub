#!/usr/bin/env node
// Real application, installer and authenticated update API; no system services.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const temporary = await mkdtemp(join(tmpdir(), 'llmhub-update-e2e-'))
const source = join(temporary, 'source')
const installation = join(temporary, 'installation')
const children = new Set()
const cancellation = new AbortController()
const interrupt = () => cancellation.abort(new Error('Update test interrupted'))
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)

function start(command, arguments_, options = {}) {
  cancellation.signal.throwIfAborted()
  const child = spawn(command, arguments_, { cwd: source, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...options })
  const state = { child, output: '', finished: false }
  children.add(state)
  const capture = chunk => { state.output = (state.output + chunk).slice(-48000) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  state.completion = new Promise(resolveCompletion => {
    child.once('error', error => { state.finished = true; resolveCompletion({ error }) })
    child.once('close', (code, signal) => { state.finished = true; resolveCompletion({ code, signal }) })
  })
  return state
}
function signal(state, name) {
  if (!state.child.pid) return
  try { process.kill(-state.child.pid, name) } catch (error) { if (error.code !== 'ESRCH') throw error }
}
async function stop(state) {
  signal(state, 'SIGTERM')
  let timeout
  try { await Promise.race([state.completion, new Promise(resolveTimeout => { timeout = setTimeout(resolveTimeout, 15000) })]) }
  finally { clearTimeout(timeout) }
  signal(state, 'SIGKILL')
  await state.completion
  children.delete(state)
}
async function run(command, arguments_, options = {}) {
  const state = start(command, arguments_, options)
  let timeout
  let onAbort
  try {
    const result = await Promise.race([state.completion, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Command timed out after 20 minutes')), 1200000)
      onAbort = () => reject(cancellation.signal.reason)
      cancellation.signal.addEventListener('abort', onAbort, { once: true })
    })])
    assert.equal(result.code, 0, `${command} ${arguments_.join(' ')}: ${result.error?.message || result.signal || result.code}\n${state.output}`)
    return state.output.trim()
  } finally {
    clearTimeout(timeout)
    cancellation.signal.removeEventListener('abort', onAbort)
    await stop(state)
  }
}
const git = (...arguments_) => run('git', arguments_)
async function commit(message) {
  await git('add', '--all')
  await git('-c', 'user.name=LLMHub Update Test', '-c', 'user.email=update-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', `${message}\n\nCo-Authored-By: programmer <noreply@programmer.local>`)
}
async function version(value, buildScript) {
  const information = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  information.version = value
  if (buildScript) information.scripts.build = buildScript
  await writeFile(join(source, 'package.json'), `${JSON.stringify(information, null, 2)}\n`)
  const lock = JSON.parse(await readFile(join(source, 'package-lock.json'), 'utf8'))
  lock.version = value
  lock.packages[''].version = value
  await writeFile(join(source, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`)
  await commit(`test fixture ${value}`)
  await git('tag', `v${value}`)
}
async function freePort() {
  const server = createServer()
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const port = server.address().port
  await new Promise(resolveClose => server.close(resolveClose))
  return port
}
let supervisor
let base
let cookie = ''
async function request(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000),
  })
  return response
}
async function status() {
  const response = await request('/api/hub/system')
  assert.equal(response.status, 200)
  return response.json()
}
async function until(check, description, timeout = 1200000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    cancellation.signal.throwIfAborted()
    if (supervisor?.finished) throw new Error(`Supervisor exited\n${supervisor.output}`)
    try { const result = await check(); if (result) return result } catch (error) { lastError = error }
    await delay(300, undefined, { signal: cancellation.signal })
  }
  throw new Error(`${description} timed out: ${lastError?.message || ''}\n${supervisor?.output || ''}`)
}
async function trigger() {
  const checked = await request('/api/hub/system/check', 'POST', {})
  assert.equal(checked.status, 200, await checked.text())
  const update = await request('/api/hub/system/update', 'POST', {})
  assert.ok(update.ok, `Update rejected: ${update.status} ${await update.text()}`)
}

try {
  await mkdir(source)
  // Copy tracked working-tree files plus the new feature files, never local data or secrets.
  const tracked = await run('git', ['ls-files', '-z', '--', '.', ':!:references'], { cwd: repository })
  for (const path of tracked.split('\0').filter(Boolean)) {
    if (path.startsWith('references/')) continue
    await mkdir(dirname(join(source, path)), { recursive: true })
    await cp(join(repository, path), join(source, path), { recursive: true })
  }
  for (const path of ['scripts', 'server/system', 'server/api/hub/system', 'server/plugins/system-updates.ts', 'shared/types/system-update.ts', 'components/SystemVersion.vue', 'components/SystemUpdateNotice.vue', 'pages/updates.vue']) {
    await mkdir(dirname(join(source, path)), { recursive: true })
    await cp(join(repository, path), join(source, path), { recursive: true })
  }
  await git('init', '-b', 'main')
  await version('1.0.0')
  const originalBuild = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).scripts.build
  // Keep the production trust boundary intact: only transport goes to our fixture.
  // Unlike Git insteadOf, this does not rewrite `remote get-url` identity checks.
  const realGit = await run('sh', ['-c', 'command -v git'])
  const binaries = join(temporary, 'bin')
  await mkdir(binaries)
  await writeFile(join(binaries, 'git'), `#!${process.execPath}\nimport { spawnSync } from 'node:child_process'\nconst arguments_ = process.argv.slice(2)\nif (arguments_[0] === 'clone' || arguments_[0] === 'ls-remote') {\n  const index = arguments_.indexOf('https://github.com/huangdihd/LLMHub.git')\n  if (index >= 0) arguments_[index] = ${JSON.stringify(source)}\n}\nconst result = spawnSync(${JSON.stringify(realGit)}, arguments_, { stdio: 'inherit' })\nif (result.error) throw result.error\nif (result.status === 0 && arguments_[0] === 'clone') {\n  const origin = spawnSync(${JSON.stringify(realGit)}, ['-C', arguments_.at(-1), 'remote', 'set-url', 'origin', 'https://github.com/huangdihd/LLMHub.git'], { stdio: 'inherit' })\n  if (origin.error) throw origin.error\n  if (origin.status !== 0) process.exit(origin.status ?? 1)\n}\nprocess.exit(result.status ?? 1)\n`)
  await chmod(join(binaries, 'git'), 0o700)
  const environment = { ...process.env, PATH: `${binaries}:${process.env.PATH}` }
  console.log('== install real old release ==')
  await run('sh', [join(source, 'install.sh')], { cwd: temporary, env: { ...environment, LLMHUB_SOURCE: 'https://github.com/huangdihd/LLMHub.git', LLMHUB_INSTALL_DIR: installation, LLMHUB_REF: 'v1.0.0', LLMHUB_SERVICE: 'no' } })
  await mkdir(join(installation, '.data'), { recursive: true })
  const marker = join(installation, '.data', 'update-test-marker')
  await writeFile(marker, 'must survive every update\n')
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  supervisor = start(process.execPath, ['scripts/update-supervisor.mjs'], {
    cwd: installation,
    env: { ...environment, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port), LLMHUB_DEPLOYMENT: 'service', LLMHUB_INSTALL_DIR: installation, NUXT_COOKIE_SECURE: 'false' },
  })
  await until(async () => (await request('/api/auth/status')).ok, 'Initial startup', 90000)
  assert.equal((await request('/api/auth/setup', 'POST', { password: 'temporary-update-test-password' })).status, 200)
  const login = await request('/api/auth/login', 'POST', { password: 'temporary-update-test-password' })
  assert.equal(login.status, 200)
  cookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal((await status()).version, '1.0.0')
  assert.equal((await request('/api/hub/system/settings', 'PUT', { automatic: false })).status, 200)
  assert.equal((await request('/api/hub/system/update', 'POST', { target: 'main' })).status, 400)

  console.log('== success: authenticated API, full build, restart and persistent data ==')
  await version('1.0.1')
  await trigger()
  const successful = await until(async () => {
    const information = await status()
    if (information.update?.phase === 'failed') throw new Error(JSON.stringify(information.update))
    return information.version === '1.0.1' && information.update?.phase === 'completed' && information
  }, 'Successful update')
  assert.equal(successful.automatic, false)
  assert.equal(await readFile(marker, 'utf8'), 'must survive every update\n')
  console.log('PASS success: version 1.0.1, completed, settings and .data retained')

  console.log('== failed build: old release serves continuously ==')
  await version('1.0.2', 'node -e "process.exit(19)"')
  await trigger()
  let probes = 0
  const probeFailures = []
  const failedBuild = await until(async () => {
    // No catch here: any failed request is tracked, rather than hidden by readiness retries.
    let information
    try {
      information = await status()
      assert.equal(information.version, '1.0.1')
      probes++
    } catch (error) { probeFailures.push(error.message); throw error }
    return information.update?.phase === 'failed' && information
  }, 'Build failure')
  assert.ok(probes > 0)
  assert.deepEqual(probeFailures, [], 'Old server must remain available during a failed build')
  assert.ok(failedBuild.update.error || failedBuild.update.message)
  assert.equal(await readFile(marker, 'utf8'), 'must survive every update\n')
  await assert.rejects(access(join(installation, '.data/updates/transaction.json')), { code: 'ENOENT' })
  console.log(`PASS failed build: old version 1.0.1 retained (${probes} live probes)`)

  console.log('== crash after switching: supervisor rolls back without the new gateway ==')
  await version('1.0.3', `${originalBuild} && node -e "require('node:fs').writeFileSync('.output/server/index.mjs', 'process.exit(23)\\n')"`)
  await trigger()
  const rolledBack = await until(async () => {
    const information = await status()
    return information.version === '1.0.1' && information.update?.phase === 'failed' && information.update?.tag === 'v1.0.3' && information
  }, 'Crash rollback')
  assert.match(rolledBack.update.error || rolledBack.update.message, /readiness|exited before|health check/i, 'Must actually switch and fail startup, not merely fail the build')
  assert.equal(await readFile(marker, 'utf8'), 'must survive every update\n')
  console.log(`PASS startup crash: rolled back to 1.0.1: ${rolledBack.update.error || rolledBack.update.message}`)
  await assert.rejects(access(join(installation, '.data/updates/transaction.json')), { code: 'ENOENT' })
  const current = JSON.parse(await readFile(join(installation, '.data/updates/current.json'), 'utf8'))
  assert.equal(current.tag, 'v1.0.1')
  await stop(supervisor)
  await assert.rejects(access(join(installation, '.data/updates/supervisor.lock')), { code: 'ENOENT' })
  console.log('PASS: all three real update paths; rollback pointer, transaction and lock cleanup verified')
} catch (error) {
  console.error(error.stack || error)
  process.exitCode = 1
} finally {
  await Promise.all([...children].map(stop))
  await rm(temporary, { recursive: true, force: true })
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
}
