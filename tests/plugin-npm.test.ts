import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('Run through tests/run-all.sh')
const { npmSpecification, githubSpecification, validateRegistry } = require(`${build}/plugins-runtime/specifications.js`)
const { PluginManager } = require(`${build}/plugins-runtime/manager.js`)
const { discoverPackages } = require(`${build}/plugins-runtime/npm-project.js`)
const { ProviderRegistry } = require(`${build}/core/registry.js`)
const { HookRegistry } = require(`${build}/core/hooks.js`)

test('package specifications separate npm from GitHub and reject executable/local inputs', () => {
  assert.equal(npmSpecification({ name: '@scope/plugin', version: '^1.2.0' }).packageName, '@scope/plugin')
  assert.equal(githubSpecification({ owner: 'owner', repo: 'plugin', ref: 'main' }).specification, 'github:owner/plugin#main')
  for (const input of ['--help', '../local', 'file:local', 'https://example.org/p.tgz', 'github:owner/plugin', 'owner/plugin', 'plugin;echo', 'plugin@npm:other']) assert.throws(() => npmSpecification(input))
  for (const input of ['git+ssh://host/repo', 'https://github.com/owner/repo', 'owner/repo#../evil', 'owner/repo;echo']) assert.throws(() => githubSpecification(input))
  assert.equal(validateRegistry('https://registry.npmjs.org'), 'https://registry.npmjs.org/')
  for (const input of ['file:///tmp', 'https://user:secret@host', 'https://host/?secret=1']) assert.throws(() => validateRegistry(input))
})

test('npm installation stages safely, infers plugin dependencies, rolls back failed setup and persists registry', async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'llmhub-npm-test-'))
  const values = new Map<string, unknown>()
  const storage = { async getItem(key: string) { return values.get(key) ?? null }, async setItem(key: string, value: unknown) { values.set(key, value) }, async removeItem(key: string) { values.delete(key) } }
  let version = '1.0.0'
  let fail = false
  const runner = async (arguments_: string[], target: string) => {
    assert.deepEqual(arguments_.slice(0, 6), ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=true'])
    const project = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'))
    if (!Object.keys(project.dependencies).length) return
    for (const name of ['plugin-child', 'plugin-parent']) {
      const root = path.join(target, 'node_modules', name)
      await mkdir(root, { recursive: true })
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'index.js', llmhub: {}, dependencies: name === 'plugin-parent' ? { 'plugin-child': '*' } : {} }))
      await writeFile(path.join(root, 'index.js'), `export default { setup(api) { ${fail && name === 'plugin-parent' ? 'throw new Error("bad setup")' : 'api.provide({ version: ' + JSON.stringify(version) + ' })'} } }`)
    }
  }
  const manager = new PluginManager({ directory, storage, providerRegistry: new ProviderRegistry(), hookRegistry: new HookRegistry(), npmRunner: runner })
  try {
    await manager.setRegistry('https://registry.example.org')
    assert.equal(await manager.getRegistry(), 'https://registry.example.org/')
    const installed = await manager.installNpm({ name: 'plugin-parent' })
    assert.equal(installed.length, 2)
    assert.equal(installed.find((plugin: any) => plugin.id === 'plugin-parent').manifest.dependencies['plugin-child'], '*')
    await manager.enable('plugin-child')
    await manager.enable('plugin-parent')
    const oldState = structuredClone(values.get('runtime-plugins:npm-project'))
    version = '2.0.0'; fail = true
    await assert.rejects(manager.update('plugin-parent'))
    assert.deepEqual(values.get('runtime-plugins:npm-project'), oldState)
    assert.ok(manager.list().every((plugin: any) => plugin.enabled && plugin.manifest.version === '1.0.0'))
    await assert.rejects(manager.uninstall('plugin-child'), /Transitive/)
    fail = false
    await manager.uninstall('plugin-parent')
    assert.equal(manager.list().length, 0)
  } finally { await manager.shutdown(); await rm(directory, { recursive: true, force: true }) }
})

test('npm root transaction preserves bytes, disabled configuration and peer graph', async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'llmhub-npm-root-'))
  const values = new Map<string, unknown>()
  const storage = {
    async getItem(key: string) { return values.get(key) ?? null },
    async setItem(key: string, value: unknown) { values.set(key, value) },
    async removeItem(key: string) { values.delete(key) },
    async getKeys(prefix: string) { return [...values.keys()].filter(key => key.startsWith(prefix)) },
  }
  let version = '1.0.0'
  let fail = false
  const runner = async (_arguments: string[], target: string) => {
    assert.ok(!target.startsWith(directory + path.sep), 'staging must be outside the plugin root')
    const project = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'))
    await writeFile(path.join(target, 'package-lock.json'), JSON.stringify({ version }))
    for (const name of Object.keys(project.dependencies).length ? ['root-parent', 'root-peer'] : []) {
      const root = path.join(target, 'node_modules', name)
      await mkdir(root, { recursive: true })
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'index.js',
        llmhub: { configSchema: name === 'root-parent' ? [{ key: 'token', type: 'text', label: 'Token', required: true }] : [] },
        peerDependencies: name === 'root-parent' ? { 'root-peer': '*' } : {} }))
      await writeFile(path.join(root, 'index.js'), `export default { setup(api) { ${fail ? 'throw new Error("failure")' : 'api.provide({})'} } }`)
    }
  }
  const manager = new PluginManager({ directory, storage, providerRegistry: new ProviderRegistry(), hookRegistry: new HookRegistry(), npmRunner: runner })
  try {
    const installed = await manager.installNpm({ name: 'root-parent' })
    assert.ok(installed.every((plugin: any) => !plugin.enabled))
    assert.equal(installed.find((plugin: any) => plugin.id === 'root-parent').manifest.dependencies['root-peer'], '*')
    assert.equal((values.get('runtime-plugins:npm-project') as any).directory, directory)
    await manager.updateConfig('root-parent', { token: 'saved' })
    await manager.enable('root-peer')
    await manager.enable('root-parent')
    const files = ['package.json', 'package-lock.json', 'node_modules/root-parent/package.json', 'node_modules/root-parent/index.js']
    const before = await Promise.all(files.map(file => readFile(path.join(directory, file))))
    version = '2.0.0'; fail = true
    await assert.rejects(manager.update('root-parent'))
    for (let index = 0; index < files.length; index++) assert.deepEqual(await readFile(path.join(directory, files[index])), before[index])
    assert.equal(manager.getConfig('root-parent').token, 'saved')
    fail = false
    await manager.update('root-parent')
    assert.ok(manager.list().every((plugin: any) => plugin.enabled))
    values.set('runtime-plugins:root-parent:storage:sample', { preserved: true })
    await manager.uninstall('root-parent')
    assert.ok(![...values.keys()].some(key => key.startsWith('runtime-plugins:root-parent:')))
    await assert.rejects(manager.uninstall('missing-plugin'), /not found/)
    await assert.rejects(manager.update('missing-plugin'), /not found/)
  } finally { await manager.shutdown(); await rm(directory, { recursive: true, force: true }) }
})

test('npm scan reports invalid metadata without executing it and serialized calls reject asynchronously', async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'llmhub-invalid-npm-'))
  const root = path.join(directory, 'node_modules', 'invalid-plugin')
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'invalid-plugin', version: 'bad', llmhub: {}, main: 'index.js' }))
  await writeFile(path.join(root, 'index.js'), 'throw new Error("must not execute")')
  const storage = { async getItem() { return null }, async setItem() {}, async removeItem() {} }
  const manager = new PluginManager({ directory, storage, providerRegistry: new ProviderRegistry(), hookRegistry: new HookRegistry(), builtinPlugins: () => [{ id: 'builtin-policy', manifest: { id: 'builtin-policy', name: 'Builtin', version: '1.0.0' }, enabled: true, status: 'enabled', providers: [], hooks: [] }] })
  try {
    const records = await manager.scan()
    assert.equal(records.find((plugin: any) => plugin.id === 'invalid-plugin').status, 'error')
    await assert.rejects(manager.enable('invalid-plugin'), /Invalid/)
    await assert.rejects(manager.uninstall('builtin-policy'), /read-only/)
    await assert.rejects(manager.update('builtin-policy'), /read-only/)
    await assert.rejects(manager.installNpm('bad input'))
  } finally { await manager.shutdown(); await rm(directory, { recursive: true, force: true }) }
})

test('GitHub upgrade refreshes its lock, persists commits and rolls back execution and storage failures', async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'llmhub-github-transaction-'))
  const values = new Map<string, unknown>()
  let failStorage = false
  const storage = {
    async getItem(key: string) { return values.get(key) ?? null },
    async setItem(key: string, value: unknown) {
      if (failStorage && key === 'runtime-plugins:npm-project') { failStorage = false; throw new Error('storage unavailable') }
      values.set(key, value)
    },
    async removeItem(key: string) { values.delete(key) },
  }
  let version = '1.0.0'
  let commit = 'a'.repeat(40)
  let failure: 'npm' | 'git' | undefined
  const runner = async (_arguments: string[], target: string) => {
    if (failure) throw new Error(`${failure} unavailable`)
    const project = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'))
    const packages: Record<string, { resolved: string }> = {}
    const lock = await readFile(path.join(target, 'package-lock.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return '{}'
    })
    if (Object.keys(project.dependencies).length) {
      assert.equal(JSON.parse(lock).packages?.['node_modules/github-plugin'], undefined, 'updating package must not keep its old locked commit')
    }
    for (const [name, specification] of Object.entries(project.dependencies)) {
      assert.ok(String(specification).startsWith('github:owner/repository#'))
      const root = path.join(target, 'node_modules', name)
      await mkdir(root, { recursive: true })
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'github-plugin', version, type: 'module', main: 'index.js', llmhub: {} }))
      await writeFile(path.join(root, 'index.js'), 'export default { setup(api) { api.provide({}) } }')
      packages[`node_modules/${name}`] = { resolved: `git+https://github.com/owner/repository.git#${commit}` }
    }
    await writeFile(path.join(target, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }))
  }
  const manager = new PluginManager({ directory, storage, providerRegistry: new ProviderRegistry(), hookRegistry: new HookRegistry(), npmRunner: runner })
  try {
    await manager.installGithub({ owner: 'owner', repo: 'repository', ref: 'main' })
    await manager.enable('github-plugin')
    const before = structuredClone(values.get('runtime-plugins:npm-project'))
    const files = ['package.json', 'package-lock.json', 'node_modules/github-plugin/package.json']
    const bytes = await Promise.all(files.map(file => readFile(path.join(directory, file))))
    version = '2.0.0'; commit = 'b'.repeat(40)
    for (const executable of ['npm', 'git'] as const) {
      failure = executable
      await assert.rejects(manager.update('github-plugin'), /Plugin operation failed/)
      assert.deepEqual(values.get('runtime-plugins:npm-project'), before)
      assert.equal(manager.list()[0].enabled, true)
    }
    failure = undefined
    failStorage = true
    await assert.rejects(manager.update('github-plugin'), /Plugin operation failed/)
    assert.deepEqual(values.get('runtime-plugins:npm-project'), before)
    for (let index = 0; index < files.length; index++) assert.deepEqual(await readFile(path.join(directory, files[index])), bytes[index])
    assert.equal(manager.list()[0].manifest.version, '1.0.0')
    assert.equal(manager.list()[0].enabled, true)
    await manager.update('github-plugin', { owner: 'owner', repo: 'repository', ref: 'v2.0.0' })
    const saved = values.get('runtime-plugins:npm-project') as any
    assert.equal(saved.sources['github-plugin'].commit, commit)
    assert.equal(saved.sources['github-plugin'].ref, 'v2.0.0')
    assert.equal(manager.list()[0].manifest.version, '2.0.0')
    assert.equal(manager.list()[0].enabled, true)

    const beforeUninstall = structuredClone([...values])
    const uninstallBytes = await Promise.all(files.map(file => readFile(path.join(directory, file))))
    failStorage = true
    await assert.rejects(manager.uninstall('github-plugin'))
    assert.equal(failStorage, false, 'uninstall must reach the injected persistence failure')
    assert.deepEqual([...values].sort(), beforeUninstall.sort())
    for (let index = 0; index < files.length; index++) assert.deepEqual(await readFile(path.join(directory, files[index])), uninstallBytes[index])
    assert.equal(manager.list()[0].enabled, true)
    assert.equal(manager.list()[0].manifest.version, '2.0.0')
    await manager.uninstall('github-plugin')
    assert.deepEqual(manager.list(), [])
  } finally { await manager.shutdown(); await rm(directory, { recursive: true, force: true }) }
})

test('manual package directories infer npm plugin dependencies before activation and reload', async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'llmhub-directory-graph-'))
  const values = new Map<string, unknown>()
  const storage = {
    async getItem(key: string) { return values.get(key) ?? null },
    async setItem(key: string, value: unknown) { values.set(key, value) },
    async removeItem(key: string) { values.delete(key) },
  }
  const manager = new PluginManager({ directory, storage, providerRegistry: new ProviderRegistry(), hookRegistry: new HookRegistry() })
  try {
    const service = path.join(directory, 'node_modules', 'llmhub-plugin-service')
    const consumer = path.join(directory, 'consumer')
    await mkdir(service, { recursive: true })
    await mkdir(consumer)
    await writeFile(path.join(service, 'package.json'), JSON.stringify({ name: 'llmhub-plugin-service', version: '1.0.0', llmhub: {} }))
    await writeFile(path.join(service, 'index.mjs'), 'export default { setup(api) { api.provide({ value: 42 }) } }')
    await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'llmhub-plugin-consumer', version: '1.0.0', llmhub: {}, peerDependencies: { 'llmhub-plugin-service': '^1.0.0' } }))
    await writeFile(path.join(consumer, 'index.mjs'), `export default { setup(api) { api.registerRoute('GET', 'value', () => api.require('service').value) } }`)
    await manager.scan()
    assert.deepEqual(manager.list().find((plugin: any) => plugin.id === 'consumer').manifest.dependencies, { service: '^1.0.0' })
    await assert.rejects(manager.enable('consumer'), /not enabled/)
    await manager.enable('service')
    await manager.enable('consumer')
    assert.equal(await manager.dispatchRoute('consumer', 'GET', 'value', {}), 42)
    await manager.reload('consumer')
    assert.equal(await manager.dispatchRoute('consumer', 'GET', 'value', {}), 42)
    await assert.rejects(manager.disable('service'), /required by enabled/)
  } finally { await manager.shutdown(); await rm(directory, { recursive: true, force: true }) }
})

test('npm discovery treats optional peers and optional overrides as optional plugin dependencies', async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'llmhub-npm-optional-'))
  try {
    for (const name of ['parent', 'peer', 'child']) {
      const root = path.join(directory, 'node_modules', name)
      await mkdir(root, { recursive: true })
      await writeFile(path.join(root, 'package.json'), JSON.stringify({
        name, version: '1.0.0', main: 'index.js', llmhub: {},
        ...(name === 'parent' ? {
          dependencies: { child: '^1.0.0' }, optionalDependencies: { child: '^1.1.0' },
          peerDependencies: { peer: '^1.0.0' }, peerDependenciesMeta: { peer: { optional: true } },
        } : {}),
      }))
      await writeFile(path.join(root, 'index.js'), 'export default {}')
    }
    const parent = (await discoverPackages(directory)).find((plugin: any) => plugin.packageName === 'parent')
    assert.deepEqual(parent.manifest.dependencies ?? {}, {})
    assert.deepEqual(parent.manifest.optionalDependencies, { peer: '^1.0.0', child: '^1.1.0' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('npm dependency inference respects ordinary-library shadowing and sibling isolation', async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'llmhub-npm-resolution-'))
  try {
    const packages = [
      ['node_modules/parent', { name: 'parent', llmhub: {}, dependencies: { service: '*', hidden: '*' } }],
      ['node_modules/service', { name: 'service', llmhub: {} }],
      ['node_modules/parent/node_modules/service', { name: 'service' }],
      ['node_modules/other', { name: 'other' }],
      ['node_modules/other/node_modules/hidden', { name: 'hidden', llmhub: {} }],
    ] as const
    for (const [relative, metadata] of packages) {
      const root = path.join(directory, relative)
      await mkdir(root, { recursive: true })
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ ...metadata, version: '1.0.0', main: 'index.js' }))
      await writeFile(path.join(root, 'index.js'), 'export default {}')
    }
    const parent = (await discoverPackages(directory)).find((plugin: any) => plugin.packageName === 'parent')
    assert.deepEqual(parent.manifest.dependencies ?? {}, {})
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('npm upgrade refreshes ordinary library imports and rollback restores library behavior', async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'llmhub-library-upgrade-'))
  const values = new Map<string, unknown>()
  let version = '1.0.0'
  let failStorage = false
  const storage = {
    async getItem(key: string) { return values.get(key) ?? null },
    async setItem(key: string, value: unknown) {
      if (failStorage && key === 'runtime-plugins:npm-project') { failStorage = false; throw new Error('storage unavailable') }
      values.set(key, value)
    },
    async removeItem(key: string) { values.delete(key) },
  }
  const runner = async (_arguments: string[], target: string) => {
    for (const name of ['library-consumer', 'ordinary-library']) {
      const root = path.join(target, 'node_modules', name)
      await mkdir(root, { recursive: true })
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'index.js',
        ...(name === 'library-consumer' ? { llmhub: {}, dependencies: { 'ordinary-library': '*' } } : {}) }))
      await writeFile(path.join(root, 'index.js'), name === 'ordinary-library'
        ? `export default ${JSON.stringify(version)}`
        : "import version from 'ordinary-library'; export default { setup(api) { api.registerRoute('GET', 'version', () => version) } }")
    }
  }
  const manager = new PluginManager({ directory, storage, providerRegistry: new ProviderRegistry(), hookRegistry: new HookRegistry(), npmRunner: runner })
  try {
    await manager.installNpm({ name: 'library-consumer' })
    await manager.enable('library-consumer')
    assert.equal(await manager.dispatchRoute('library-consumer', 'GET', 'version', {}), '1.0.0')
    version = '2.0.0'
    await manager.update('library-consumer')
    assert.equal(await manager.dispatchRoute('library-consumer', 'GET', 'version', {}), '2.0.0')
    version = '3.0.0'
    failStorage = true
    await assert.rejects(manager.update('library-consumer'))
    assert.equal(failStorage, false)
    assert.equal(await manager.dispatchRoute('library-consumer', 'GET', 'version', {}), '2.0.0')
  } finally { await manager.shutdown(); await rm(directory, { recursive: true, force: true }) }
})
