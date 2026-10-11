import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, appendFile, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { buildRelease, run, signalGroup } from './release-build.mjs'

export const officialSource = 'https://github.com/huangdihd/LLMHub.git'
export function validateRequest(request) {
  if (!request || typeof request.tag !== 'string' || typeof request.commit !== 'string' || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(request.tag)
    || !/^[a-f0-9]{40}$/.test(request.commit)) throw new Error('Expected stable vX.Y.Z tag and full commit SHA')
  return { tag: request.tag, commit: request.commit }
}
export function remoteCommit(output, tag) {
  const entries = new Map(output.split('\n').filter(Boolean).map(line => line.trim().split(/\s+/).reverse()))
  return entries.get(`refs/tags/${tag}^{}`) ?? entries.get(`refs/tags/${tag}`)
}
export async function atomicJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}
async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}
async function git(directory, arguments_, signal) {
  return run('git', arguments_, { directory, capture: true, signal })
}
export async function initialize(root) {
  const updates = join(root, '.data/updates')
  await mkdir(updates, { recursive: true, mode: 0o700 })
  const source = await git(root, ['remote', 'get-url', 'origin'])
  const record = join(updates, 'source.json')
  try { await writeFile(record, JSON.stringify({ source }), { flag: 'wx', mode: 0o400 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    if ((await readJSON(record)).source !== source) throw new Error('Installation origin changed')
  }
  const exclude = join(root, '.git/info/exclude')
  const contents = await readFile(exclude, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  if (!contents.split('\n').includes('/.llmhub-releases/')) await appendFile(exclude, '\n/.llmhub-releases/\n')
}
export async function acquireLock(directory) {
  const lock = join(directory, 'supervisor.lock')
  try { await mkdir(lock, { mode: 0o700 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error('Supervisor lock exists; another supervisor may be running. After an unclean shutdown, verify its owner is dead before removing supervisor.lock.')
  }
  try { await atomicJSON(join(lock, 'owner.json'), { pid: process.pid }) }
  catch (error) { await rm(lock, { recursive: true, force: true }); throw error }
  return () => rm(lock, { recursive: true, force: true })
}

export async function supervise(root) {
  root = await realpath(root)
  const updates = join(root, '.data/updates')
  await initialize(root)
  const releaseLock = await acquireLock(updates)
  const releases = join(root, '.llmhub-releases')
  const cancellation = new AbortController()
  const interrupt = () => cancellation.abort(new Error('Supervisor stopping'))
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  let child
  let current = { directory: root }
  let operation
  const status = async (stage, extra = {}) => atomicJSON(join(updates, 'status.json'), {
    ...operation, stage, updatedAt: new Date().toISOString(), ...extra,
  })
  const validDirectory = async record => {
    const directory = await realpath(record.directory)
    if (directory !== root && dirname(directory) !== releases) throw new Error('Release directory is outside installation')
    await access(join(directory, '.output/server/index.mjs'))
    return directory
  }
  const start = async record => {
    const directory = await validDirectory(record)
    const process_ = spawn(process.execPath, [join(directory, '.output/server/index.mjs')], {
      cwd: root, detached: true, stdio: 'inherit', env: {
        ...process.env, NODE_ENV: 'production', LLMHUB_DEPLOYMENT: 'service', LLMHUB_INSTALL_DIR: root,
        LLMHUB_RELEASE_TAG: record.tag ?? '', LLMHUB_RELEASE_COMMIT: record.commit ?? '',
      },
    })
    process_.failure = undefined
    process_.completion = new Promise(resolveExit => {
      process_.once('error', error => { process_.failure = error; resolveExit() })
      process_.once('exit', resolveExit)
    })
    return process_
  }
  const stop = async () => {
    if (!child) return
    signalGroup(child, 'SIGTERM')
    let timeout
    try { await Promise.race([child.completion, new Promise(resolveTimeout => { timeout = setTimeout(resolveTimeout, 10000) })]) }
    finally { clearTimeout(timeout) }
    signalGroup(child, 'SIGKILL')
    await child.completion
    child = undefined
  }
  const healthy = async () => {
    const host = process.env.NITRO_HOST ?? process.env.HOST ?? '127.0.0.1'
    let address = host
    if (host === '0.0.0.0') address = '127.0.0.1'
    else if (host === '::') address = '[::1]'
    else if (host.includes(':')) address = `[${host}]`
    const port = process.env.NITRO_PORT ?? process.env.PORT ?? '3000'
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      cancellation.signal.throwIfAborted()
      if (child.failure || child.exitCode !== null || child.signalCode) throw new Error('Application exited before readiness')
      try {
        const response = await fetch(`http://${address}:${port}/api/auth/status`, { signal: AbortSignal.timeout(2000) })
        const body = await response.json()
        if (response.ok && typeof body.initialized === 'boolean' && typeof body.authenticated === 'boolean') {
          await delay(500)
          if (child.exitCode === null && !child.signalCode && !child.failure) return
        }
      } catch { /* Readiness is retried until the deadline; child death is checked above. */ }
      await delay(250)
    }
    throw new Error('Application health check timed out')
  }
  const clean = async directory => {
    if (await git(directory, ['status', '--porcelain', '--untracked-files=all'], cancellation.signal)) throw new Error(`Local changes in ${directory}; update refused`)
  }
  try {
    await mkdir(releases, { recursive: true, mode: 0o700 })
    if (await realpath(releases) !== releases) throw new Error('Release directory must not be a symlink')
    current = await readJSON(join(updates, 'current.json'), current)
    // A crash between pointer switch and successful health must restore the old release.
    const pending = await readJSON(join(updates, 'transaction.json'))
    if (pending) {
      current = pending.previous
      await validDirectory(current)
      await atomicJSON(join(updates, 'current.json'), current)
      await status('failed', { error: 'Interrupted update rolled back' })
      await rm(join(updates, 'transaction.json'))
    }
    const interrupted = await readJSON(join(updates, 'status.json'))
    if (interrupted && !['completed', 'failed'].includes(interrupted.stage)) {
      await status('failed', { tag: interrupted.tag, commit: interrupted.commit, error: 'Interrupted update; active release retained' })
    }
    child = await start(current)
    while (!cancellation.signal.aborted) {
      if (child.failure || child.exitCode !== null || child.signalCode) throw new Error('Application process exited')
      let request
      try { request = await readJSON(join(updates, 'request.json')) }
      catch (error) {
        await status('failed', { error: error.message })
        await rm(join(updates, 'request.json'), { force: true })
      }
      if (!request) { await delay(500); continue }
      let staged
      let switched = false
      const previous = current
      let obsolete
      try {
        operation = validateRequest(request)
        await status('downloading')
        await rm(join(updates, 'request.json'))
        const { source } = await readJSON(join(updates, 'source.json'))
        if (source !== officialSource || await git(root, ['remote', 'get-url', 'origin']) !== source) throw new Error('One-click updates require the recorded official origin')
        await clean(root)
        if (current.directory !== root) await clean(await validDirectory(current))
        const remote = await git(root, ['ls-remote', '--tags', source, `refs/tags/${operation.tag}`, `refs/tags/${operation.tag}^{}`], cancellation.signal)
        if (remoteCommit(remote, operation.tag) !== operation.commit) throw new Error('Official tag does not match requested commit')
        staged = join(releases, `${operation.tag}-${operation.commit}-${Date.now()}`)
        await git(root, ['clone', '--no-checkout', '--', source, staged], cancellation.signal)
        await git(staged, ['checkout', '--detach', operation.commit], cancellation.signal)
        if (await git(staged, ['rev-parse', `refs/tags/${operation.tag}^{commit}`]) !== operation.commit) throw new Error('Tag changed during download')
        const currentCommit = await git(current.directory, ['rev-parse', 'HEAD'], cancellation.signal)
        if (current.commit && currentCommit !== current.commit) throw new Error('Active release checkout was changed locally')
        await git(staged, ['merge-base', '--is-ancestor', currentCommit, operation.commit], cancellation.signal)
        await buildRelease(staged, { signal: cancellation.signal, onStage: status, prune: true })
        await clean(root)
        if (current.directory !== root) await clean(current.directory)
        await status('switching')
        const next = { directory: staged, ...operation }
        await atomicJSON(join(updates, 'transaction.json'), { previous, next })
        switched = true
        await atomicJSON(join(updates, 'current.json'), next)
        await status('restarting')
        await stop()
        child = await start(next)
        await healthy()
        obsolete = await readJSON(join(updates, 'previous.json'))
        await atomicJSON(join(updates, 'previous.json'), previous)
        await status('completed')
        await rm(join(updates, 'transaction.json'))
        current = next
        staged = undefined
        switched = false
      } catch (error) {
        let rollbackError
        if (switched) {
          try {
            await stop()
            await atomicJSON(join(updates, 'current.json'), previous)
            current = previous
            child = await start(previous)
            if (!cancellation.signal.aborted) await healthy()
            await rm(join(updates, 'transaction.json'), { force: true })
          } catch (failure) { rollbackError = failure.message }
        }
        // Reclaim failed build space before writing status (npm can exhaust disk).
        if (staged && !rollbackError) await rm(staged, { recursive: true, force: true })
        await status('failed', { error: error.message, ...(rollbackError ? { rollbackError } : {}) })
        await rm(join(updates, 'request.json'), { force: true })
        if (rollbackError) throw new Error(`Rollback failed: ${rollbackError}`)
      } finally { operation = undefined }
      if (obsolete && obsolete.directory !== root && obsolete.directory !== current.directory && obsolete.directory !== previous.directory) {
        try {
          const directory = await validDirectory(obsolete)
          await clean(directory)
          await rm(directory, { recursive: true })
        } catch (error) { console.error(`Retained old release: ${error.message}`) }
      }
    }
  } finally {
    cancellation.abort()
    await stop()
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    await releaseLock()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.env.LLMHUB_INSTALL_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
  const operation = process.argv[2] === '--initialize' ? initialize(root) : supervise(root)
  operation.catch(error => { console.error(error.message); process.exitCode = 1 })
}
