import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function signalGroup(child, signal) {
  if (!child?.pid) return
  try { process.kill(-child.pid, signal) }
  catch (error) { if (error.code !== 'ESRCH') throw error }
}

// npm and git can leave descendants behind; timeout/cancellation owns the whole group.
export async function run(command, arguments_, { directory, timeout = 120000, signal, capture = false, environment = {} } = {}) {
  signal?.throwIfAborted()
  const child = spawn(command, arguments_, {
    cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...environment, GIT_TERMINAL_PROMPT: '0' },
  })
  let output = ''
  let failure
  let forceTimer
  const cancel = (error) => {
    failure ??= error
    signalGroup(child, 'SIGTERM')
    forceTimer ??= setTimeout(() => signalGroup(child, 'SIGKILL'), 3000)
  }
  const abort = () => cancel(signal.reason ?? new Error('Cancelled'))
  const timer = setTimeout(() => cancel(new Error(`${command} timed out`)), timeout)
  signal?.addEventListener('abort', abort, { once: true })
  let diskFull = false
  // Never forward package-manager or Git output: registry URLs may contain credentials.
  child.stdout.on('data', chunk => {
    if (capture) output = (output + chunk).slice(-1048576)
    if (/ENOSPC|no space left on device/i.test(String(chunk))) diskFull = true
  })
  child.stderr.on('data', chunk => {
    if (/ENOSPC|no space left on device/i.test(String(chunk))) diskFull = true
  })
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('close', resolveExit)
    })
    if (failure) throw failure
    if (diskFull) throw new Error('ENOSPC: not enough disk space to prepare the release')
    if (code !== 0) throw new Error(`${command} failed (exit ${code})`)
    return output.trim()
  } finally {
    clearTimeout(timer)
    clearTimeout(forceTimer)
    signal?.removeEventListener('abort', abort)
    // Kill surviving descendants even if the leader exited first.
    signalGroup(child, 'SIGKILL')
  }
}

export async function buildRelease(directory, { signal, onStage = async () => {} } = {}) {
  await onStage('installing')
  await run('npm', ['ci', '--include=dev'], { directory, timeout: 900000, signal })
  await onStage('building')
  await run('npm', ['run', 'build'], {
    directory, timeout: 900000, signal, environment: { NITRO_PRESET: 'node-server' },
  })
  await access(resolve(directory, '.output/server/index.mjs'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const cancellation = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => cancellation.abort(new Error(signal)))
  buildRelease(resolve(process.argv[2] ?? '.'), {
    signal: cancellation.signal, onStage: async stage => console.log(`==> ${stage}`),
  }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
