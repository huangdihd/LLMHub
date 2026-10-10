import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import type { PackageCommandOptions } from '../server/plugins-runtime/package-operations.ts'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('Run through tests/run-all.sh')
const { packageCapabilities, packageUpdates } = require(`${build}/plugins-runtime/package-operations.js`)
const { npmSpecification, githubSpecification } = require(`${build}/plugins-runtime/specifications.js`)
const firstCommit = 'a'.repeat(40)
const nextCommit = 'b'.repeat(40)

function assertOptions(options: PackageCommandOptions) {
  assert.equal(options.shell, false)
  assert.equal(options.timeout, 15_000)
  assert.equal(options.maxBuffer, 4 * 1024 * 1024)
  assert.equal(options.env.GIT_TERMINAL_PROMPT, '0')
}

test('capabilities probe each executable independently and report missing tools and timeout', async () => {
  const result = await packageCapabilities(async (file: string, arguments_: string[], options: PackageCommandOptions) => {
    assertOptions(options)
    assert.deepEqual(arguments_, ['--version'])
    if (file === 'git') throw Object.assign(new Error('private stderr'), { code: 'ENOENT' })
    return '10.2.0\n'
  })
  assert.deepEqual(result, { npm: { available: true, version: '10.2.0' }, git: { available: false, reason: 'Executable not found' } })
  const timeout = await packageCapabilities(async () => { throw Object.assign(new Error(), { killed: true }) })
  assert.equal(timeout.npm.reason, 'Command timed out')
  assert.equal((await packageCapabilities(async () => '')).git.available, false)
})

test('real subprocesses report missing npm and git without changing the parent PATH', async () => {
  const script = `
    const assert = require('node:assert/strict')
    const { packageCapabilities } = require(${JSON.stringify(`${build}/plugins-runtime/package-operations.js`)})
    const { runNpm } = require(${JSON.stringify(`${build}/plugins-runtime/npm-project.js`)})
    ;(async () => {
      assert.deepEqual(await packageCapabilities(), {
        npm: { available: false, reason: 'Executable not found' },
        git: { available: false, reason: 'Executable not found' },
      })
      await assert.rejects(runNpm(['--version'], process.cwd()), /npm is unavailable/)
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `
  await promisify(execFile)(process.execPath, ['-e', script], {
    env: { ...process.env, PATH: '/nonexistent-llmhub-package-test' }, timeout: 10_000,
  })
})

test('npm queries configured registry without shell, deduplicates and sorts all later versions', async () => {
  const result = await packageUpdates(npmSpecification({ name: '@scope/plugin', version: '^1.0.0' }), 'https://registry.example.test/custom', '1.0.0', async (file: string, arguments_: string[], options: PackageCommandOptions) => {
    assertOptions(options)
    assert.equal(file, 'npm')
    if (arguments_[2] === 'dist-tags.latest') return '"2.0.0"'
    assert.deepEqual(arguments_, ['view', '@scope/plugin', 'versions', '--json', '--registry', 'https://registry.example.test/custom/'])
    return JSON.stringify(['2.0.0', '0.9.0', '1.0.0', '1.2.0', '1.2.0'])
  })
  const { latestVersion, latestMatchingVersion, ...legacyResult } = result
  assert.equal(latestVersion, '2.0.0')
  assert.equal(latestMatchingVersion, '1.2.0')
  assert.deepEqual(legacyResult, { available: true, currentVersion: '1.0.0', updates: [{ version: '1.2.0' }, { version: '2.0.0' }] })
})

test('npm supports singleton response and distinguishes unavailable registry from no updates', async () => {
  const source = npmSpecification({ name: 'plugin' })
  const query = (executor: () => Promise<string>) => packageUpdates(source, 'https://registry.example.test', '1.0.0', async (_file: string, arguments_: string[]) => arguments_[2] === 'dist-tags.latest' ? '"1.0.0"' : executor())
  assert.deepEqual((await query(async () => '"1.0.0"')).updates, [])
  assert.equal((await query(async () => '[]')).available, true)
  for (const output of ['not json', '{"error":"private"}', '["not-semver"]', '[1]']) {
    const result = await query(async () => output)
    assert.equal(result.available, false)
    assert.ok(result.reason)
  }
  const failure = await query(async () => { throw new Error('secret registry token') })
  assert.equal(failure.available, false)
  assert.ok(!failure.reason.includes('secret'))
  assert.equal((await query(async () => { throw Object.assign(new Error(), { code: 'ETIMEDOUT' }) })).reason, 'Command timed out')
})

test('GitHub queries HTTPS refs only and uses peeled tags and tracked branch commits', async () => {
  const source = { ...githubSpecification({ url: 'https://github.com/owner/plugin/tree/main' }), commit: firstCommit }
  const result = await packageUpdates(source, 'unused', '1.0.0', async (file: string, arguments_: string[], options: PackageCommandOptions) => {
    assertOptions(options)
    assert.equal(file, 'git')
    assert.deepEqual(arguments_, ['ls-remote', 'https://github.com/owner/plugin.git', 'HEAD', 'refs/tags/*', 'refs/heads/*'])
    return `${nextCommit}\trefs/heads/main\n${firstCommit}\trefs/tags/v2.0.0\n${nextCommit}\trefs/tags/v2.0.0^{}\n${firstCommit}\trefs/tags/v0.9.0\n${nextCommit}\trefs/heads/1.3.0\n`
  })
  assert.equal(result.available, true)
  assert.deepEqual(result.updates, [{ version: '1.3.0', ref: '1.3.0', commit: nextCommit }, { version: '2.0.0', ref: 'v2.0.0', commit: nextCommit }])
  assert.deepEqual(result.trackedRef, { ref: 'main', currentCommit: firstCommit, commit: nextCommit, changed: true })
})

test('GitHub tracks default HEAD and tags; unchanged or unknown installed commit is explicit', async () => {
  for (const commit of [nextCommit, undefined]) {
    const result = await packageUpdates({ ...githubSpecification({ owner: 'owner', repo: 'plugin' }), commit }, '', '1.0.0', async () => `${nextCommit}\tHEAD\n`)
    assert.equal(result.trackedRef.changed, commit ? false : null)
  }
  const result = await packageUpdates({ ...githubSpecification({ owner: 'owner', repo: 'plugin', ref: 'v1.0.0' }), commit: firstCommit }, '', '1.0.0', async () => `${firstCommit}\trefs/tags/v1.0.0\n${nextCommit}\trefs/tags/v1.0.0^{}\n`)
  assert.equal(result.trackedRef.commit, nextCommit)
})

test('GitHub reports missing refs, malformed results and remote failures instead of false no-update success', async () => {
  const source = githubSpecification({ owner: 'owner', repo: 'plugin', ref: 'main' })
  for (const output of ['', 'invalid', `${firstCommit}\trefs/heads/other\n`]) {
    const result = await packageUpdates(source, '', '1.0.0', async () => output)
    assert.equal(result.available, false)
    assert.ok(result.reason)
  }
  assert.equal((await packageUpdates(source, '', '1.0.0', async () => { throw new Error('network') })).available, false)
})

test('GitHub tracks qualified refs and keeps same-named branches and tags unambiguous', async () => {
  const output = `${firstCommit}\trefs/heads/v2.0.0\n${nextCommit}\trefs/tags/v2.0.0\n`
  const result = await packageUpdates(githubSpecification({ owner: 'owner', repo: 'plugin', ref: 'refs/tags/v2.0.0' }), '', '1.0.0', async () => output)
  assert.equal(result.available, true)
  assert.equal(result.trackedRef.commit, nextCommit)
  assert.deepEqual(result.updates, [
    { version: '2.0.0', ref: 'refs/heads/v2.0.0', commit: firstCommit },
    { version: '2.0.0', ref: 'refs/tags/v2.0.0', commit: nextCommit },
  ])
})

test('GitHub semver build tags advertised as updates remain installable specifications', async () => {
  const ref = 'v2.0.0+build.7'
  const result = await packageUpdates(githubSpecification({ owner: 'owner', repo: 'plugin' }), '', '1.0.0', async () => `${firstCommit}\tHEAD\n${nextCommit}\trefs/tags/${ref}\n`)
  assert.equal(result.available, true)
  assert.equal(result.updates.length, 1)
  assert.equal(result.updates[0].ref, ref)
  assert.equal(githubSpecification({ owner: 'owner', repo: 'plugin', ref: result.updates[0].ref }).specification, `github:owner/plugin#${ref}`)
})

test('invalid persisted metadata is rejected before executing commands', async () => {
  let calls = 0
  const executor = async () => { calls++; return '' }
  for (const [source, registry, version] of [
    [{ source: 'npm', packageName: '--help' }, 'https://registry.example.test', '1.0.0'],
    [{ source: 'npm', packageName: 'plugin' }, 'file:///tmp', '1.0.0'],
    [{ source: 'github', owner: 'owner', repo: 'plugin;echo' }, '', '1.0.0'],
    [{ source: 'npm', packageName: 'plugin' }, 'https://registry.example.test', 'invalid'],
    [{ source: 'local' }, '', '1.0.0'],
  ]) assert.equal((await packageUpdates(source, registry, version, executor)).available, false)
  assert.equal(calls, 0)
})

test('npm latest metadata distinguishes dist-tag latest from greatest version satisfying the stored range', async () => {
  const calls: string[][] = []
  const result = await packageUpdates(npmSpecification({ name: '@scope/plugin', version: '^1.0.0' }), 'https://registry.example.test/custom', '1.0.0', async (file: string, arguments_: string[], options: PackageCommandOptions) => {
    assert.equal(file, 'npm')
    assertOptions(options)
    calls.push(arguments_)
    return JSON.stringify(arguments_[2] === 'versions' ? ['3.0.0', '1.8.0', '2.0.0', '1.9.0-beta.1', '1.2.0'] : '2.0.0')
  })
  assert.deepEqual(calls, [
    ['view', '@scope/plugin', 'versions', '--json', '--registry', 'https://registry.example.test/custom/'],
    ['view', '@scope/plugin', 'dist-tags.latest', '--json', '--registry', 'https://registry.example.test/custom/'],
  ])
  assert.equal(result.available, true)
  assert.equal(result.latestVersion, '2.0.0')
  assert.equal(result.latestMatchingVersion, '1.8.0')
})

test('npm latest metadata reports no matching range, default range and explicit prerelease ranges', async () => {
  for (const [range, expected] of [[undefined, '2.0.0'], ['^4.0.0', null], ['1.0.0', '1.0.0'], ['^3.0.0-beta.1', '3.0.0-beta.2']] as const) {
    const result = await packageUpdates(npmSpecification({ name: 'plugin', version: range }), 'https://registry.example.test', '2.0.0', async (_file: string, arguments_: string[]) => JSON.stringify(arguments_[2] === 'versions' ? ['1.0.0', '2.0.0', '3.0.0-beta.2'] : '1.0.0'))
    assert.equal(result.available, true)
    assert.equal(result.latestVersion, '1.0.0')
    assert.equal(result.latestMatchingVersion, expected)
  }
})

test('npm latest metadata validates dist-tag responses and sanitizes second-query failures', async () => {
  for (const output of ['not json', 'null', '[]', '{}', '1', '"invalid"']) {
    const result = await packageUpdates(npmSpecification({ name: 'plugin' }), 'https://registry.example.test', '1.0.0', async (_file: string, arguments_: string[]) => arguments_[2] === 'versions' ? '["1.0.0"]' : output)
    assert.equal(result.available, false)
    assert.ok(result.reason)
  }
  const result = await packageUpdates(npmSpecification({ name: 'plugin' }), 'https://registry.example.test', '1.0.0', async (_file: string, arguments_: string[]) => {
    if (arguments_[2] === 'versions') return '["1.0.0"]'
    throw new Error('secret registry token')
  })
  assert.equal(result.available, false)
  assert.ok(!result.reason.includes('secret'))
})
