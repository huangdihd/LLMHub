import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireLock, atomicJSON, remoteCommit, supervise, validateRequest } from '../../scripts/update-supervisor.mjs'
import { run } from '../../scripts/release-build.mjs'

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
