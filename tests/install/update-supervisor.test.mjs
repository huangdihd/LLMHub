import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireLock, atomicJSON, remoteCommit, supervise, validateRequest } from '../../scripts/update-supervisor.mjs'
import { buildRelease, run } from '../../scripts/release-build.mjs'
import { chmod, stat } from 'node:fs/promises'

const commit = 'a'.repeat(40)
test('requests only accept stable tags and full immutable commits', () => {
  assert.deepEqual(validateRequest({ tag: 'v12.34.56', commit, injected: true }), { tag: 'v12.34.56', commit })
  for (const tag of ['main', 'v1.2.3-rc.1', 'v01.2.3', '--upload-pack=evil', '../v1.2.3']) {
    assert.throws(() => validateRequest({ tag, commit }))
  }
  assert.throws(() => validateRequest({ tag: 'v1.2.3', commit: 'aaaaaaa' }))
  assert.throws(() => validateRequest({ tag: ['v1.2.3'], commit }))
  assert.throws(() => validateRequest({ tag: 'v1.2.3', commit: [commit] }))
})
test('annotated tag uses peeled commit, never tag object', () => {
  assert.equal(remoteCommit(`bbbb\trefs/tags/v1.2.3\n${commit}\trefs/tags/v1.2.3^{}`, 'v1.2.3'), commit)
  assert.equal(remoteCommit(`${commit}\trefs/tags/v1.2.3`, 'v1.2.3'), commit)
  assert.equal(remoteCommit(`${commit}\trefs/tags/v1.2.30`, 'v1.2.3'), undefined)
})
test('atomic state replacement and exclusive supervisor lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llmhub-supervisor-test-'))
  try {
    const release = await acquireLock(directory)
    await assert.rejects(acquireLock(directory), /lock exists/)
    const file = join(directory, 'status.json')
    await atomicJSON(file, { stage: 'building' })
    await atomicJSON(file, { stage: 'completed' })
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { stage: 'completed' })
    await release()
    const releaseAgain = await acquireLock(directory)
    await releaseAgain()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('failed and concurrent atomic writes leave no temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llmhub-state-test-'))
  try {
    const file = join(directory, 'state.json')
    await Promise.all(Array.from({ length: 20 }, (_, index) => atomicJSON(file, { index })))
    assert.equal(typeof JSON.parse(await readFile(file, 'utf8')).index, 'number')
    await mkdir(join(directory, 'blocked'))
    await assert.rejects(atomicJSON(join(directory, 'blocked'), {}))
    assert.deepEqual((await readdir(directory)).sort(), ['blocked', 'state.json'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('supervisor rejects symlinked release storage and releases its lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llmhub-release-boundary-'))
  try {
    await run('git', ['init', directory], { capture: true })
    await run('git', ['remote', 'add', 'origin', 'https://github.com/huangdihd/LLMHub.git'], { directory })
    await mkdir(join(directory, 'outside'))
    await writeFile(join(directory, 'outside', 'marker'), 'retain')
    await symlink(join(directory, 'outside'), join(directory, '.llmhub-releases'))
    await assert.rejects(supervise(directory), /must not be a symlink/)
    assert.equal(await readFile(join(directory, 'outside', 'marker'), 'utf8'), 'retain')
    assert.equal((await readdir(join(directory, '.data/updates'))).includes('supervisor.lock'), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('restart clears abandoned build status before running the retained release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llmhub-interrupted-build-'))
  try {
    await run('git', ['init', directory], { capture: true })
    await run('git', ['remote', 'add', 'origin', 'https://github.com/huangdihd/LLMHub.git'], { directory })
    await mkdir(join(directory, '.output/server'), { recursive: true })
    await writeFile(join(directory, '.output/server/index.mjs'), 'process.exit(23)\n')
    await mkdir(join(directory, '.data/updates'), { recursive: true })
    await atomicJSON(join(directory, '.data/updates/status.json'), { stage: 'building', tag: 'v1.2.3', commit })
    await assert.rejects(supervise(directory), /Application process exited/)
    const status = JSON.parse(await readFile(join(directory, '.data/updates/status.json'), 'utf8'))
    assert.equal(status.stage, 'failed')
    assert.equal(status.tag, 'v1.2.3')
    assert.match(status.error, /Interrupted update/)
    assert.equal((await readdir(join(directory, '.data/updates'))).includes('supervisor.lock'), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('bounded commands capture output, reject failures and time out', async () => {
  assert.equal(await run(process.execPath, ['-e', 'console.log("ok")'], { capture: true }), 'ok')
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(7)'], { capture: true }), /exit 7/)
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 50, capture: true }), /timed out/)
})

test('a pruned release keeps only what runs: .output, not node_modules or .nuxt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'llmhub-prune-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  // A stand-in npm: `ci` fills node_modules, `run build` writes .nuxt and .output like Nuxt does.
  const bin = join(root, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'npm'), `#!/bin/sh
if [ "$1" = ci ]; then mkdir -p node_modules/.cache && echo x > node_modules/.cache/vite; fi
if [ "$1" = run ]; then mkdir -p .nuxt .output/server/node_modules && echo x > .output/server/index.mjs && echo x > .nuxt/app; fi
`)
  await chmod(join(bin, 'npm'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  t.after(() => { process.env.PATH = path })
  const exists = file => stat(file).then(() => true, () => false)

  const kept = join(root, 'kept')
  await mkdir(kept)
  await buildRelease(kept)
  assert.deepEqual([await exists(join(kept, 'node_modules')), await exists(join(kept, '.nuxt'))], [true, true], 'not pruned unless asked')

  const pruned = join(root, 'pruned')
  await mkdir(pruned)
  await writeFile(join(pruned, 'package.json'), '{}')
  const stages = []
  await buildRelease(pruned, { prune: true, onStage: async stage => stages.push(stage) })
  assert.deepEqual(stages, ['installing', 'building'])
  assert.equal(await exists(join(pruned, 'node_modules')), false)
  assert.equal(await exists(join(pruned, '.nuxt')), false)
  assert.equal(await exists(join(pruned, '.output/server/index.mjs')), true)
  assert.equal(await exists(join(pruned, '.output/server/node_modules')), true, 'the build output keeps its own dependencies')
  assert.equal(await exists(join(pruned, 'package.json')), true)
})
