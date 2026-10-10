#!/usr/bin/env node
// Standalone, real install/upgrade test: node tests/install/run-install.mjs
// Requires git, npm, network access for npm ci, and the installer's Node version.
// Source is committed HEAD, not uncommitted application changes. Only the installer
// is taken from the working tree. No service is registered and no npm test hook exists.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const installerPath = join(repositoryDirectory, 'install.sh')
const children = new Set()
const cancellation = new AbortController()
let temporaryDirectory

function interrupt(signal) {
  cancellation.abort(new Error(`Interrupted by ${signal}`))
}
const onInterrupt = () => interrupt('SIGINT')
const onTerminate = () => interrupt('SIGTERM')
process.on('SIGINT', onInterrupt)
process.on('SIGTERM', onTerminate)

function signalChild(child, signal) {
  if (!child.pid) return
  try {
    // Each command owns a process group, including npm's build descendants.
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

function start(command, arguments_, options = {}) {
  cancellation.signal.throwIfAborted()
  const child = spawn(command, arguments_, {
    cwd: repositoryDirectory,
    env: process.env,
    ...options,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state = { child, output: '', finished: false }
  children.add(state)
  const capture = (chunk) => { state.output = (state.output + chunk.toString()).slice(-64000) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  state.completion = new Promise((resolveCompletion) => {
    child.once('error', (error) => {
      state.finished = true
      resolveCompletion({ code: null, error })
    })
    child.once('close', (code, signal) => {
      state.finished = true
      resolveCompletion({ code, signal })
    })
  })
  return state
}

async function stop(state) {
  signalChild(state.child, 'SIGTERM')
  await Promise.race([state.completion, delay(3000)])
  // Also terminate descendants when their group leader has already exited.
  signalChild(state.child, 'SIGKILL')
  await state.completion
  children.delete(state)
}

async function run(command, arguments_, options = {}, expectFailure = false) {
  const state = start(command, arguments_, options)
  let timer
  let abortHandler
  try {
    const result = await Promise.race([
      state.completion,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${command} timed out after 15 minutes`)), 900000)
        abortHandler = () => reject(cancellation.signal.reason)
        cancellation.signal.addEventListener('abort', abortHandler, { once: true })
      }),
    ])
    if (result.error) throw result.error
    assert.equal(result.signal, null, `${command} was killed by ${result.signal}`)
    if (expectFailure) assert.notEqual(result.code, 0, 'Installer must refuse a dirty worktree')
    else assert.equal(result.code, 0, `${command} ${arguments_.join(' ')} failed`)
    return state.output.trim()
  } catch (error) {
    throw new Error(`${error.message}\n${state.output}`, { cause: error })
  } finally {
    clearTimeout(timer)
    cancellation.signal.removeEventListener('abort', abortHandler)
    await stop(state)
  }
}

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const { port } = server.address()
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return port
}

async function checkServer(installationDirectory) {
  const port = await freePort()
  const server = start(process.execPath, ['.output/server/index.mjs'], {
    cwd: installationDirectory,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NITRO_PORT: String(port), NITRO_HOST: '127.0.0.1' },
  })
  let lastError
  try {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      cancellation.signal.throwIfAborted()
      if (server.finished) throw new Error('Installed server exited before becoming ready')
      try {
        const homepage = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) })
        await homepage.text()
        assert.equal(homepage.status, 200, 'Homepage status')
        const response = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { signal: AbortSignal.timeout(3000) })
        assert.equal(response.status, 200, 'Authentication status endpoint')
        const status = await response.json()
        assert.equal(status.initialized, false, 'Fresh installation must not be initialized')
        assert.equal(status.authenticated, false, 'Anonymous request must not be authenticated')
        if (server.finished) throw new Error('Installed server exited during readiness checks')
        return
      } catch (error) {
        lastError = error
      }
      await delay(250, undefined, { signal: cancellation.signal })
    }
    throw new Error(`Installed server was not ready within 60 seconds: ${lastError?.message}`)
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${server.output}`, { cause: error })
  } finally {
    await stop(server)
  }
}

try {
  await access(installerPath)
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'llmhub-install-test-'))
  const sourceDirectory = join(temporaryDirectory, 'source')
  const installationDirectory = join(temporaryDirectory, 'installation')
  const committedHead = await run('git', ['rev-parse', 'HEAD'])
  await run('git', ['clone', '--no-local', '--no-checkout', repositoryDirectory, sourceDirectory])
  const sourceOptions = { cwd: sourceDirectory }
  await run('git', ['checkout', '-B', 'install-test', committedHead], sourceOptions)
  const installerEnvironment = {
    ...process.env,
    LLMHUB_INSTALL_DIR: installationDirectory,
    LLMHUB_SOURCE: sourceDirectory,
    LLMHUB_REF: 'install-test',
    LLMHUB_SERVICE: 'no',
    LLMHUB_DRY_RUN: '0',
  }
  const install = (overrides = {}, expectFailure = false) => run('sh', [installerPath], {
    cwd: temporaryDirectory,
    env: { ...installerEnvironment, ...overrides },
  }, expectFailure)

  console.log('== dry run leaves installation directory absent ==')
  const entriesBeforeDryRun = await readdir(temporaryDirectory)
  await install({ LLMHUB_DRY_RUN: '1' })
  await assert.rejects(access(installationDirectory), { code: 'ENOENT' })
  assert.deepEqual(await readdir(temporaryDirectory), entriesBeforeDryRun)

  console.log('== first install builds a runnable, uninitialized application ==')
  await install()
  await access(join(installationDirectory, '.output/server/index.mjs'))
  const installationOptions = { cwd: installationDirectory }
  assert.equal(await run('git', ['rev-parse', 'HEAD'], installationOptions), committedHead)
  await checkServer(installationDirectory)

  console.log('== upgrade advances source and preserves .data ==')
  await mkdir(join(installationDirectory, '.data'), { recursive: true })
  const dataPath = join(installationDirectory, '.data', 'installation-test-marker.txt')
  const dataMarker = 'Persistent installation test data\n'
  await writeFile(dataPath, dataMarker)
  const upgradeFilename = 'installation-test-marker.txt'
  const upgradeMarker = 'Upgrade from the temporary source repository\n'
  await writeFile(join(sourceDirectory, upgradeFilename), upgradeMarker)
  await run('git', ['add', '--', upgradeFilename], sourceOptions)
  // Explicitly authorized test commit: only the disposable SOURCE repository.
  await run('git', [
    '-c', 'user.name=LLMHub Installation Test', '-c', 'user.email=install-test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
    'commit', '-m', 'test: installation upgrade fixture\n\nCo-Authored-By: programmer <noreply@programmer.local>',
  ], sourceOptions)
  const upgradedHead = await run('git', ['rev-parse', 'HEAD'], sourceOptions)
  await install()
  assert.equal(await run('git', ['rev-parse', 'HEAD'], installationOptions), upgradedHead)
  assert.equal(await readFile(join(installationDirectory, upgradeFilename), 'utf8'), upgradeMarker)
  assert.equal(await readFile(dataPath, 'utf8'), dataMarker)
  await access(join(installationDirectory, '.output/server/index.mjs'))
  await checkServer(installationDirectory)

  console.log('== dirty tracked worktree is refused without losing changes ==')
  const dirtyMarker = 'Local modification that must not be overwritten\n'
  await writeFile(join(installationDirectory, upgradeFilename), dirtyMarker)
  await install({}, true)
  assert.equal(await readFile(join(installationDirectory, upgradeFilename), 'utf8'), dirtyMarker)
  assert.equal(await readFile(dataPath, 'utf8'), dataMarker)
  assert.equal(await run('git', ['rev-parse', 'HEAD'], installationOptions), upgradedHead)
  console.log('PASS: dry run, first install, HTTP/auth checks, upgrade, data preservation, dirty worktree refusal')
} catch (error) {
  console.error(error.stack || error)
  process.exitCode = 1
} finally {
  try {
    await Promise.all([...children].map(stop))
  } finally {
    try {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    } finally {
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onTerminate)
    }
  }
}
