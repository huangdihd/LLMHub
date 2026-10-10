import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, lstat, readdir, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { createModuleGeneration } = require(`${process.env.ADAPTER_BUILD}/plugins-runtime/module-generation.js`)

test('failed snapshots remove temporary files and leave rejected symlinks untouched', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'llmhub-generation-failure-test-'))
  const source = join(root, 'plugin')
  try {
    await mkdir(source)
    await writeFile(join(source, 'index.mjs'), 'export default 1')
    await symlink(join(source, 'index.mjs'), join(source, 'linked.mjs'))
    await assert.rejects(createModuleGeneration(source, root), /symlinks are not allowed/)
    assert.deepEqual(await readdir(root), ['plugin'])
    assert.equal((await lstat(join(source, 'linked.mjs'))).isSymbolicLink(), true)
    // Dependencies are linked by the host, but plugin-provided directory links
    // must not bypass the source-path checks.
    await rm(join(source, 'linked.mjs'))
    const libraries = join(root, 'libraries')
    await mkdir(libraries)
    await writeFile(join(libraries, 'sentinel'), 'untouched')
    await symlink(libraries, join(source, 'node_modules'), 'dir')
    await assert.rejects(createModuleGeneration(source, root), /node_modules must be a regular directory/)
    assert.deepEqual((await readdir(root)).sort(), ['libraries', 'plugin'])
    assert.equal(await readFile(join(libraries, 'sentinel'), 'utf8'), 'untouched')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('large library batches stay asynchronous and drain before failed-generation cleanup', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'llmhub-generation-batch-test-'))
  const source = join(root, 'plugin')
  const snapshots = join(root, '.generations')
  const library = join(root, 'node_modules/undeclared-library')
  let generation: { directory: string; dispose(): Promise<void> } | undefined
  let ticks = 0
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    await mkdir(source)
    await mkdir(library, { recursive: true })
    await writeFile(join(source, 'index.cjs'), "module.exports = require('undeclared-library/file-2047.cjs')")
    for (let batch = 0; batch < 16; batch++) {
      await Promise.all(Array.from({ length: 128 }, (_, index) =>
        writeFile(join(library, `file-${batch * 128 + index}.cjs`), 'module.exports = 42')))
    }
    timer = setInterval(() => ticks++, 1)
    generation = await createModuleGeneration(source, root)
    clearInterval(timer)
    assert.ok(ticks > 0, 'library traversal must yield to the event loop')
    assert.equal(createRequire(join(generation.directory, 'index.cjs'))('./index.cjs'), 42)
    assert.equal((await lstat(join(dirname(generation.directory), 'node_modules/undeclared-library/file-2047.cjs'))).ino,
      (await lstat(join(library, 'file-2047.cjs'))).ino)
    await generation.dispose()
    await symlink(library, join(library, 'cycle'), 'dir')
    await assert.rejects(createModuleGeneration(source, root), /Cyclic library directory link/)
    await assert.rejects(readdir(snapshots), { code: 'ENOENT' }, 'failed concurrent work must finish before disposal')
  } finally {
    if (timer) clearInterval(timer)
    await generation?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

for (const location of ['local-plugin', 'node_modules/llmhub-plugin-example', 'node_modules/@example/plugin', 'node_modules/host/node_modules/@example/plugin']) {
  test(`module generations preserve library resolution and refresh relative imports: ${location}`, async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'llmhub-generation-test-'))
    const source = join(root, location)
    const snapshots = join(root, '.generations')
    const generations: Array<{ directory: string; dispose(): Promise<void> }> = []
    const library = async (directory: string, name: string, value: string) => {
      const target = join(directory, 'node_modules', name)
      await mkdir(target, { recursive: true })
      await writeFile(join(target, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }))
      await writeFile(join(target, 'index.js'), `export default ${JSON.stringify(value)}`)
    }
    try {
      await mkdir(source, { recursive: true })
      await library(root, 'root-library', 'root')
      await library(root, '@example/sibling', 'scoped')
      await mkdir(join(root, 'node_modules/common-library'))
      await writeFile(join(root, 'node_modules/common-library/index.js'), 'module.exports = { value: 1 }')
      await library(source, 'nested-library', 'nested')
      await library(root, 'shadowed-library', 'root-shadowed')
      await library(source, 'shadowed-library', 'plugin-shadowed')
      await library(join(source, 'feature'), 'shadowed-library', 'feature-shadowed')
      await writeFile(join(source, 'feature/index.mjs'), "import value from 'shadowed-library'; export default value")
      await writeFile(join(source, 'package.json'), JSON.stringify({
        name: 'generation-package', type: 'module', exports: './self.js', imports: { '#value': './value.mjs' }
      }))
      await writeFile(join(source, 'self.js'), "export { default } from '#value'")
      await writeFile(join(source, 'package-check.mjs'), "import self from 'generation-package'; import shadowed from 'shadowed-library'; import feature from './feature/index.mjs'; export default { self, shadowed, feature }")
      await writeFile(join(source, 'index.mjs'), `import root from 'root-library'; import scoped from '@example/sibling'; import nested from 'nested-library'; import value from './value.mjs'; export default { root, scoped, nested, value }; export const lazy = () => import('./lazy.mjs')`)
      await writeFile(join(source, 'value.mjs'), 'export default 1')
      await writeFile(join(source, 'lazy.mjs'), 'export default 1')
      await writeFile(join(source, 'value.cjs'), 'module.exports = 1')
      await writeFile(join(source, 'commonjs.cjs'), "module.exports = require('./value.cjs')")
      await writeFile(join(source, 'library-check.mjs'), "import esm from 'root-library'; import commonjs from 'common-library'; export default { esm, commonjs }")
      const sourceEntries = await readdir(source)
      const first = await createModuleGeneration(source, root)
      generations.push(first)
      const oldModule = await import(pathToFileURL(join(first.directory, 'index.mjs')).href)
      assert.deepEqual(oldModule.default, { root: 'root', scoped: 'scoped', nested: 'nested', value: 1 })
      assert.equal((await import(pathToFileURL(join(first.directory, 'commonjs.cjs')).href)).default, 1)
      assert.equal((await lstat(join(first.directory, 'node_modules/nested-library/index.js'))).ino, (await lstat(join(source, 'node_modules/nested-library/index.js'))).ino)
      assert.equal((await lstat(join(first.directory, 'feature/node_modules/shadowed-library/index.js'))).ino, (await lstat(join(source, 'feature/node_modules/shadowed-library/index.js'))).ino)
      // A hoisted library is linked, including when mirrored plugin code occupies its parent tree.
      let ancestor = dirname(first.directory)
      while (!await lstat(join(ancestor, 'node_modules/root-library')).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return false
      })) {
        assert.notEqual(ancestor, dirname(ancestor), 'hoisted library must remain reachable')
        ancestor = dirname(ancestor)
      }
      assert.equal((await lstat(join(ancestor, 'node_modules/root-library/index.js'))).ino, (await lstat(join(root, 'node_modules/root-library/index.js'))).ino)
      assert.deepEqual((await import(pathToFileURL(join(first.directory, 'package-check.mjs')).href)).default,
        { self: 1, shadowed: 'plugin-shadowed', feature: 'feature-shadowed' })
      const oldLibraries = (await import(pathToFileURL(join(first.directory, 'library-check.mjs')).href)).default
      assert.deepEqual(oldLibraries, { esm: 'root', commonjs: { value: 1 } })
      // npm replaces files rather than mutating shared hard-link inodes in place.
      await rm(join(root, 'node_modules/root-library/index.js'))
      await writeFile(join(root, 'node_modules/root-library/index.js'), 'export default "updated-root"')
      await rm(join(root, 'node_modules/common-library/index.js'))
      await writeFile(join(root, 'node_modules/common-library/index.js'), 'module.exports = { value: 2 }')
      await writeFile(join(source, 'value.mjs'), 'export default 2')
      await writeFile(join(source, 'lazy.mjs'), 'export default 2')
      await writeFile(join(source, 'value.cjs'), 'module.exports = 2')
      const second = await createModuleGeneration(source, root)
      generations.push(second)
      const newModule = await import(pathToFileURL(join(second.directory, 'index.mjs')).href)
      assert.deepEqual(newModule.default, { root: 'updated-root', scoped: 'scoped', nested: 'nested', value: 2 })
      assert.deepEqual((await import(pathToFileURL(join(second.directory, 'library-check.mjs')).href)).default,
        { esm: 'updated-root', commonjs: { value: 2 } })
      assert.deepEqual(oldLibraries, { esm: 'root', commonjs: { value: 1 } })
      assert.equal((await import(pathToFileURL(join(second.directory, 'commonjs.cjs')).href)).default, 2)
      assert.equal((await import(pathToFileURL(join(first.directory, 'commonjs.cjs')).href)).default, 1)
      assert.deepEqual((await import(pathToFileURL(join(second.directory, 'package-check.mjs')).href)).default,
        { self: 2, shadowed: 'plugin-shadowed', feature: 'feature-shadowed' })
      assert.equal((await oldModule.lazy()).default, 1)
      assert.equal((await newModule.lazy()).default, 2)
      for (const generation of generations) {
        await generation.dispose()
        assert.equal(require.cache[join(generation.directory, 'commonjs.cjs')], undefined, 'disposing generations releases CommonJS cache entries')
        assert.equal(require.cache[join(generation.directory, 'value.cjs')], undefined, 'disposing generations releases transitive CommonJS cache entries')
        await assert.rejects(readFile(join(generation.directory, 'index.mjs')), { code: 'ENOENT' })
      }
      assert.equal(Object.keys(require.cache).some(filename => filename.startsWith(`${snapshots}/`)), false, 'hoisted CommonJS libraries must also leave the cache')
      await assert.rejects(readdir(snapshots), { code: 'ENOENT' }, 'disposing generations removes the entire mirrored ancestry')
      for (let iteration = 0; iteration < 3; iteration++) {
        const generation = await createModuleGeneration(source, root)
        generations.push(generation)
        await import(pathToFileURL(join(generation.directory, 'index.mjs')).href)
        await generation.dispose()
        await assert.rejects(readdir(snapshots), { code: 'ENOENT' }, 'reloads must not accumulate directories')
      }
      assert.deepEqual(await readdir(source), sourceEntries)
      assert.equal(await readFile(join(source, 'node_modules/nested-library/index.js'), 'utf8'), 'export default "nested"')
    } finally {
      for (const generation of generations) await generation.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}
