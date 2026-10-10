import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const buildDirectory = process.env.ADAPTER_BUILD
if (!buildDirectory) throw new Error('Run through tests/run-all.sh')
const { ProviderRegistry } = require(`${buildDirectory}/core/registry.js`)
const { HookRegistry } = require(`${buildDirectory}/core/hooks.js`)
const { PluginManager } = require(`${buildDirectory}/plugins-runtime/manager.js`)

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'llmhub-disabled-reload-'))
  const marker = join(root, 'executed')
  const values = new Map<string, unknown>()
  const storage = {
    async getItem(key: string) { return structuredClone(values.get(key) ?? null) },
    async setItem(key: string, value: unknown) { values.set(key, structuredClone(value)) },
    async removeItem(key: string) { values.delete(key) }
  }
  const manager = new PluginManager({ directory: root, storage, providerRegistry: new ProviderRegistry(), hookRegistry: new HookRegistry() })
  async function writeManifest(id: string, fields: Record<string, unknown> = {}) {
    await mkdir(join(root, id), { recursive: true })
    await writeFile(join(root, id, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', engines: { llmhub: '*' }, entry: 'index.mjs', ...fields }))
  }
  return {
    manager, values, writeManifest,
    async writePlugin(id: string, fields: Record<string, unknown> = {}) {
      await writeManifest(id, fields)
      // A top-level marker detects imports even when setup is never called.
      await writeFile(join(root, id, 'index.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export default { setup() {} };`)
    },
    async assertNotExecuted() { await assert.rejects(readFile(marker), { code: 'ENOENT' }) },
    async close() { await manager.shutdown(); await rm(root, { recursive: true, force: true }) }
  }
}

for (const dependencyField of ['dependencies', 'optionalDependencies']) {
  for (const multipleNodes of [false, true]) {
    test(`disabled reload rejects ${multipleNodes ? 'multi-node' : 'self'} ${dependencyField} cycle before mutation or import`, async () => {
      const state = await fixture()
      try {
        await state.writePlugin('target')
        if (multipleNodes) await state.writePlugin('peer', { [dependencyField]: { target: '*' } })
        await state.manager.scan()
        const before = state.manager.list()
        const persisted = structuredClone(state.values)
        await state.writeManifest('target', { [dependencyField]: { [multipleNodes ? 'peer' : 'target']: '*' } })
        await assert.rejects(state.manager.reload('target'), /Dependency cycle among:/)
        assert.deepEqual(state.manager.list(), before)
        assert.deepEqual(state.values, persisted)
        await state.assertNotExecuted()
      } finally { await state.close() }
    })
  }
}

test('disabled reload permits missing dependencies and ignores unrelated cycles without importing modules', async () => {
  const state = await fixture()
  try {
    await state.writePlugin('target')
    await state.writePlugin('unrelated', { dependencies: { unrelated: '*' } })
    await state.manager.scan()
    await state.writeManifest('target', { dependencies: { missing: '*' } })
    await state.manager.reload('target')
    const target = state.manager.list().find((candidate: { id: string }) => candidate.id === 'target')
    assert.equal(target.enabled, false)
    assert.deepEqual(target.manifest.dependencies, { missing: '*' })
    await state.assertNotExecuted()
  } finally { await state.close() }
})
