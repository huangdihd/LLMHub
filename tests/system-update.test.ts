import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('Run via tests/run-all.sh')
const { latestStableRelease, OFFICIAL_REPOSITORY, compareVersions, runGit } = require(`${build}/system/releases.js`)
const { SystemUpdateManager } = require(`${build}/system/manager.js`)
const { createUpdateFiles } = require(`${build}/system/update-files.js`)
const { startSystemUpdateChecks } = require(`${build}/system/scheduler.js`)
const { safeUpdateError } = require(`${build}/system/errors.js`)
const commit = 'a'.repeat(40)
const peeled = 'b'.repeat(40)
const remote = `${commit}\trefs/tags/v2.0.0\n${peeled}\trefs/tags/v2.0.0^{}`

function fixture(overrides: Record<string, any> = {}) {
  const settings = new Map<string, unknown>()
  const requests: unknown[] = []
  const calls: string[][] = []
  const options = {
    build: { version: '1.0.0', commit, deployment: 'unknown' },
    directory: '/installation', development: false,
    environment: { LLMHUB_DEPLOYMENT: 'service', LLMHUB_INSTALL_DIR: '/installation' },
    storage: {
      async getItem(key: string) { return settings.get(key) ?? null },
      async setItem(key: string, value: unknown) { settings.set(key, value) }
    },
    files: {
      async source() { return OFFICIAL_REPOSITORY }, async supervisorRunning() { return true },
      async status() { return null }, async pending() { return false },
      async publish(value: unknown) { requests.push(value) }
    },
    async git(arguments_: string[]) {
      calls.push(arguments_)
      return arguments_[0] === 'remote' ? OFFICIAL_REPOSITORY : remote
    },
    ...overrides
  }
  return { manager: new SystemUpdateManager(options), options, requests, calls }
}

test('stable release parser ignores malformed/prerelease tags and prefers peeled commits', () => {
  const output = `${remote}\n${commit}\trefs/tags/v10.1.0\n${commit}\trefs/tags/v100.0.0-beta\n${commit}\trefs/tags/v010.2.0\n${commit}\trefs/tags/20.0.0`
  assert.deepEqual(latestStableRelease(remote), { tag: 'v2.0.0', version: '2.0.0', commit: peeled })
  assert.equal(latestStableRelease(output).tag, 'v10.1.0')
  assert.equal(latestStableRelease(`${commit}\trefs/tags/v3.0.0^{}`), null)
  assert.equal(latestStableRelease('malformed'), null)
})

test('detection/settings remain offline injectable and select only latest stable server-side', async () => {
  const { manager, requests, calls, options } = fixture()
  assert.equal((await manager.overview()).check.status, 'unchecked')
  assert.equal(await manager.automatic(), true)
  await manager.setAutomatic(false)
  assert.equal(await new SystemUpdateManager(options).automatic(), false)
  await manager.setAutomatic(true)
  assert.equal(await manager.automatic(), true)
  assert.equal(await new SystemUpdateManager(options).automatic(), true)
  assert.equal((await manager.check()).status, 'available')
  await manager.requestUpdate()
  assert.deepEqual(requests, [{ tag: 'v2.0.0', commit: peeled }])
  assert.equal(calls.filter(arguments_ => arguments_[0] === 'ls-remote').length, 2)
})

test('deployment and repository overrides constrain one-click capability', async () => {
  for (const overrides of [
    { development: true },
    { build: { version: '1.0.0', commit, deployment: 'docker' } },
    { environment: {} },
    { environment: { LLMHUB_DEPLOYMENT: 'service', LLMHUB_INSTALL_DIR: '/installation', LLMHUB_UPDATE_REPOSITORY: 'https://example.com/other.git' } }
  ]) {
    const { manager, requests } = fixture(overrides)
    assert.equal((await manager.overview()).canUpdate, false)
    await assert.rejects(manager.requestUpdate(), { statusCode: 409 })
    assert.equal(requests.length, 0)
  }
  assert.equal((await fixture({ environment: {} }).manager.overview()).deployment, 'manual')
  assert.equal((await fixture({ development: true }).manager.overview()).deployment, 'development')
})

test('failed checks redact credentials and never publish; current and empty releases never update', async () => {
  const failed = fixture({ git: async () => { throw new Error('https://user:secret@example.com/private') } })
  const result = await failed.manager.check()
  assert.equal(result.status, 'failed')
  assert.ok(!JSON.stringify(result).includes('secret'))
  for (const output of ['', `${commit}\trefs/tags/v1.0.0`, `${commit}\trefs/tags/v0.9.0`]) {
    const { manager, requests } = fixture({ git: async (arguments_: string[]) => arguments_[0] === 'remote' ? OFFICIAL_REPOSITORY : output })
    await assert.rejects(manager.requestUpdate(), { statusCode: 409 })
    assert.equal(requests.length, 0)
  }
})

test('pending status and concurrent requests reject with conflict', async () => {
  const { manager, options, requests } = fixture()
  options.files.status = async () => ({ phase: 'building' }) as any
  await assert.rejects(manager.requestUpdate(), { statusCode: 409 })
  options.files.status = async () => null
  const first = manager.requestUpdate()
  await assert.rejects(manager.requestUpdate(), { statusCode: 409 })
  await first
  assert.equal(requests.length, 1)
  options.files.pending = async () => true
  await assert.rejects(manager.requestUpdate(), { statusCode: 409 })
})

test('request publication is atomic/exclusive and persisted status is sanitized', async () => {
  const root = await mkdtemp(join(tmpdir(), 'llmhub-system-test-'))
  try {
    const files = createUpdateFiles(root)
    const request = { tag: 'v2.0.0', commit: peeled }
    const results = await Promise.allSettled([files.publish(request), files.publish(request)])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.deepEqual(JSON.parse(await readFile(join(root, '.data/updates/request.json'), 'utf8')), request)
    assert.equal(await files.pending(), true)
    await writeFile(join(root, '.data/updates/status.json'), JSON.stringify({ stage: 'failed', ...request, error: 'https://secret@host/repo', extra: 'secret' }))
    assert.deepEqual(await files.status(), { phase: 'failed', ...request, error: 'Update failed. Inspect the local supervisor logs.' })
    assert.equal(await files.supervisorRunning(), false)
    await mkdir(join(root, '.data/updates/supervisor.lock'))
    await writeFile(join(root, '.data/updates/supervisor.lock/owner.json'), JSON.stringify({ pid: process.pid }))
    assert.equal(await files.supervisorRunning(), true)
    await writeFile(join(root, '.data/updates/status.json'), '{')
    await assert.rejects(files.status(), /could not be read/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('background timer delays, isolates failures, observes settings, and stops', async () => {
  let checks = 0
  let automatic = false
  const stop = startSystemUpdateChecks({
    async automatic() { return automatic },
    async check() { checks++; throw new Error('offline') }
  }, 10, 10)
  assert.equal(checks, 0)
  await delay(25)
  assert.equal(checks, 0)
  automatic = true
  await delay(35)
  assert.ok(checks >= 1)
  stop()
  const before = checks
  await delay(30)
  assert.equal(checks, before)
})

test('semantic version precedence prevents prerelease/build metadata downgrades', async () => {
  for (const [version, status] of [
    ['3.0.0-beta.1', 'current'], ['2.0.0+build.5', 'current'],
    ['2.0.0-beta.1', 'available'], ['1.9.0-dev', 'available'], ['unknown', 'failed']
  ]) {
    const { manager } = fixture({ build: { version, commit: 'c'.repeat(40), deployment: 'unknown' } })
    assert.equal((await manager.check()).status, status, version)
  }
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1)
  assert.equal(compareVersions('1.0.0+local', '1.0.0'), 0)
  assert.throws(() => compareVersions('1.0.0-01', '1.0.0'))
})

test('manual and source-built Docker deployments expose origin-based stable build commands', async () => {
  const manual = await fixture({ environment: {} }).manager.overview()
  const docker = await fixture({ build: { version: '1.0.0', commit, deployment: 'docker' } }).manager.overview()
  for (const overview of [docker]) {
    assert.match(overview.command, /git ls-remote --tags origin/)
    assert.match(overview.command, /git fetch origin/)
    assert.match(overview.command, /git checkout --detach FETCH_HEAD/)
    assert.doesNotMatch(overview.command, /compose pull/)
  }
  assert.match(manual.command, /install\.sh/)
  assert.match(manual.command, /LLMHUB_SERVICE=no/)
  assert.match(manual.command, /git remote get-url origin/)
  assert.match(docker.command, /docker compose build && docker compose up -d/)
})

test('recorded custom origin supports real release checks but cannot authorize executable updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'llmhub-local-source-'))
  try {
    const origin = join(root, 'origin')
    const installation = join(root, 'installation')
    await runGit(['init', origin])
    await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], origin)
    await runGit(['tag', 'v2.0.0'], origin)
    await runGit(['clone', origin, installation])
    const files = createUpdateFiles(installation)
    await mkdir(join(installation, '.data/updates/supervisor.lock'), { recursive: true })
    await writeFile(join(installation, '.data/updates/source.json'), JSON.stringify({ source: origin }))
    await writeFile(join(installation, '.data/updates/supervisor.lock/owner.json'), JSON.stringify({ pid: process.pid }))
    const { manager } = fixture({ directory: installation, git: runGit, files,
      environment: { LLMHUB_DEPLOYMENT: 'service', LLMHUB_INSTALL_DIR: installation } })
    assert.equal((await manager.overview()).canUpdate, false)
    assert.equal((await manager.check()).tag, 'v2.0.0')
    await assert.rejects(manager.requestUpdate(), { statusCode: 409 })
    assert.equal(await files.pending(), false)
    await runGit(['remote', 'set-url', 'origin', `${origin}-changed`], installation)
    assert.equal((await manager.overview()).canUpdate, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('safe failure classification preserves reasons without leaking subprocess credentials', async () => {
  for (const [message, expected] of [
    ['fatal: Authentication failed for https://user:secret@host/repo', /authentication failed/],
    ['fatal: unable to access https://user:secret@host/repo: Could not resolve host', /connect/],
    ['npm failed (exit 1)', /build failed/],
    ['Application health check timed out', /timed out/],
    ['Tag changed during download', /tag no longer matches/]
  ] as const) {
    const sanitized = safeUpdateError(message)
    assert.match(sanitized, expected)
    assert.doesNotMatch(sanitized, /secret|https:/)
  }
  const root = await mkdtemp(join(tmpdir(), 'llmhub-error-status-'))
  try {
    await mkdir(join(root, '.data/updates'), { recursive: true })
    await writeFile(join(root, '.data/updates/status.json'), JSON.stringify({ stage: 'failed', error: 'npm failed (exit 1)', rollbackError: 'Application exited before readiness https://secret@host' }))
    const status = await createUpdateFiles(root).status()
    assert.match(status.error, /^Rollback failed: .*readiness/)
    assert.doesNotMatch(status.error, /secret|https:/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
