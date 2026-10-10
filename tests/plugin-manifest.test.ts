import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { PluginManifest, PluginRecord } from '../shared/types/plugin.ts'

const require = createRequire(import.meta.url)
const buildDirectory = process.env.ADAPTER_BUILD
if (!buildDirectory) throw new Error('Run through tests/run-all.sh')
const { validateManifest, validatePackageManifest, normalizeManifest, PluginError } = require(`${buildDirectory}/plugins-runtime/manifest.js`)
const { parseUploadedManifest } = require(`${buildDirectory}/plugins-runtime/upload-manifest.js`)
const { assertCompatibility, manifestWarnings, dependencyOrder, dependencyIssues, decorateRecords } = require(`${buildDirectory}/plugins-runtime/dependencies.js`)
const { discoverPackages } = require(`${buildDirectory}/plugins-runtime/npm-project.js`)
const { PLUGIN_API_VERSION } = require(`${buildDirectory}/core/plugin-version.js`)

const manifest = (id = 'test-plugin', extra: Partial<PluginManifest> = {}): PluginManifest => ({ id, name: id, version: '1.0.0', ...extra })
const literal = "{ id: 'test-plugin', name: 'Test', version: '1.0.0' }"
const declaration = `export const manifest = ${literal};`
const record = (value: PluginManifest, extra: Partial<PluginRecord> = {}): PluginRecord => ({ id: value.id, manifest: value, enabled: true, status: 'enabled', providers: [], hooks: [], ...extra })

test('package manifests map llmhub metadata without importing npm dependencies into the plugin graph', () => {
  const parsed = validatePackageManifest({
    name: '@example/llmhub-plugin-text-service', version: '1.2.3', description: 'Package description',
    engines: { node: '>=22', llmhub: '^1.0.0' },
    dependencies: { '@npm/library': 'file:../library' }, optionalDependencies: { native: 'latest' },
    llmhub: { name: 'Text Service', dependencies: { 'other-service': '^1.0.0' },
      optionalDependencies: { audit: '*' }, ui: { page: 'settings.html' },
      configSchema: [{ key: 'prefix', type: 'text', default: 'hello' }] }
  })
  assert.equal(parsed.id, 'text-service')
  assert.equal(parsed.name, 'Text Service')
  assert.equal(validatePackageManifest({ name: 'llmhub-plugin-example', version: '1.0.0', llmhub: {} }).id, 'example')
  assert.equal(validatePackageManifest({ name: '@scope/example', version: '1.0.0', llmhub: {} }).id, 'example')
  assert.equal(parsed.description, 'Package description')
  assert.equal(parsed.entry, 'index.mjs')
  assert.deepEqual(parsed.engines, { llmhub: '^1.0.0' })
  assert.deepEqual(parsed.dependencies, { 'other-service': '^1.0.0' })
  assert.deepEqual(parsed.optionalDependencies, { audit: '*' })
  assert.deepEqual(parsed.ui, { page: 'settings.html' })
  assert.equal(parsed.configSchema[0].default, 'hello')
  assert.equal(validatePackageManifest({ name: 'plain-plugin', version: '1.0.0', llmhub: {} }).name, 'plain-plugin')
  assert.equal(validatePackageManifest({ name: '@scope/plugin.with_underscores', version: '1.0.0', llmhub: { id: 'explicit-plugin' } }).id, 'explicit-plugin')
})

test('npm graph inference includes only discovered plugins and preserves explicit gateway ranges', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'llmhub-manifest-inference-'))
  const install = async (name: string, metadata: Record<string, unknown>) => {
    const directory = join(root, 'node_modules', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...metadata }))
    await writeFile(join(directory, 'index.mjs'), 'throw new Error("discovery must not execute code")')
  }
  try {
    await install('ordinary-library', {})
    await install('@example/service', { llmhub: { id: 'service' } })
    await install('@example/optional', { llmhub: { id: 'optional-service' } })
    await install('@example/consumer', {
      llmhub: { id: 'consumer', dependencies: { service: '^1.0.0' } },
      dependencies: { 'ordinary-library': 'file:../library', '@example/service': '*', '@example/optional': '*' },
      optionalDependencies: { '@example/optional': '^1.0.0', absent: '*' }
    })
    const plugins = await discoverPackages(root)
    assert.equal(plugins.length, 3)
    const consumer = plugins.find((plugin: { manifest: PluginManifest }) => plugin.manifest.id === 'consumer')
    assert.deepEqual(consumer.manifest.dependencies, { service: '^1.0.0' })
    assert.deepEqual(consumer.manifest.optionalDependencies, { 'optional-service': '^1.0.0' })
    assert.deepEqual(dependencyIssues(consumer.manifest, [record(manifest('service'))]), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('package entry selection follows root exports, main and default precedence', () => {
  const base = { name: 'package-plugin', version: '1.0.0', llmhub: {} }
  for (const [extra, expected] of [
    [{}, 'index.mjs'],
    [{ main: './main.js' }, 'main.js'],
    [{ main: 'main.mjs' }, 'main.mjs'],
    [{ exports: './export.mjs', main: 'main.js' }, 'export.mjs'],
    [{ exports: { '.': './root.mjs', './feature': './feature.mjs' } }, 'root.mjs'],
    [{ exports: { browser: './browser.js', require: './require.cjs', import: './import.mjs', default: './default.js' } }, 'import.mjs'],
    [{ exports: { '.': { node: { import: './node.mjs' }, default: './default.js' } } }, 'node.mjs'],
    [{ exports: { node: { require: './node.cjs' }, default: './default.js' } }, 'default.js'],
    [{ exports: { default: './first.js', import: './second.js' } }, 'first.js'],
    [{ main: 'main.js', llmhub: { entry: './ignored.mjs' } }, 'main.js'],
    [{ llmhub: { entry: './ignored.mjs' } }, 'index.mjs']
  ] as const) assert.equal(validatePackageManifest({ ...base, ...extra }).entry, expected)
})

test('package manifests reject invalid metadata and unsafe or unresolvable entry targets', () => {
  const base = { name: 'package-plugin', version: '1.0.0', llmhub: {} }
  for (const extra of [
    { name: '../plugin' }, { name: '@scope/' }, { name: 'Uppercase' }, { name: 'plugin.with.dot' },
    { name: 'a'.repeat(42) }, { name: 'a' }, { version: 'legacy' }, { type: 'invalid' },
    { llmhub: null }, { llmhub: [] }, { llmhub: 'plugin' }, { llmhub: { id: '' } },
    { llmhub: { name: '' } }, { llmhub: { dependencies: { '@npm/library': '*' } } },
    { llmhub: { configSchema: [{ key: 'secret', type: 'secret', default: 'unsafe' }] } },
    { main: '../outside.js' }, { main: '/outside.js' }, { main: 42 },
    { exports: null }, { exports: [] }, { exports: 'bare-package' },
    { exports: { './feature': './feature.js' } }, { exports: { require: './require.cjs' } },
    { exports: { '.': './index.js', import: './mixed.js' } },
    { exports: { import: null, default: './fallback.js' } },
    { exports: './a/../outside.js' }, { exports: './%2e%2e/outside.js' },
    { engines: { llmhub: 'invalid range' } }
  ]) assert.throws(() => validatePackageManifest({ ...base, ...extra }), PluginError, JSON.stringify(extra))
  for (const input of [null, [], 'package', {}, { name: 'package-plugin', version: '1.0.0' }]) {
    assert.throws(() => validatePackageManifest(input), PluginError)
  }
})

test('normalization and literal upload support both package and unchanged legacy manifest shapes', () => {
  const legacy = manifest('legacy-plugin', { version: 'legacy' })
  assert.deepEqual(normalizeManifest(legacy), validateManifest(legacy))
  assert.throws(() => normalizeManifest(legacy, true), PluginError)
  const packaged = { name: '@scope/package-plugin', version: '1.0.0', llmhub: { id: 'uploaded-plugin' } }
  assert.deepEqual(normalizeManifest(packaged), validatePackageManifest(packaged))
  assert.deepEqual(parseUploadedManifest(`export const manifest = ${JSON.stringify(packaged)};`), validatePackageManifest(packaged))
  assert.deepEqual(parseUploadedManifest(declaration), validateManifest({ id: 'test-plugin', name: 'Test', version: '1.0.0' }, true))
  assert.throws(() => normalizeManifest({ ...packaged, llmhub: null }), PluginError)
  assert.throws(() => parseUploadedManifest(`export const manifest = { name: 'package-plugin', version: '1.0.0', llmhub: { ...metadata } };`), PluginError)
})

test('shipped package and legacy examples have valid manifests', async () => {
  const directory = new URL('../examples/plugins/', import.meta.url)
  const packaged = validatePackageManifest(JSON.parse(await readFile(new URL('package-service/package.json', directory), 'utf8')))
  assert.equal(packaged.id, 'example-package-service')
  assert.equal(packaged.entry, 'index.js')
  assert.match(await readFile(new URL(`package-service/${packaged.entry}`, directory), 'utf8'), /export default/)
  for (const [filename, id] of [
    ['echo.mjs', 'example-echo'], ['system-prompt.mjs', 'example-system-prompt'],
    ['text-service.mjs', 'example-text-service'], ['text-consumer.mjs', 'example-text-consumer'],
    ['package-upload.mjs', 'example-package-upload']
  ]) assert.equal(parseUploadedManifest(await readFile(new URL(filename!, directory), 'utf8')).id, id)
})

test('manifest validates semver ranges, preserves metadata and tolerates legacy disk versions', () => {
  const input = manifest('test-plugin', { engines: { llmhub: '^1.0.0' }, dependencies: { 'text-service': '>=1 <3' }, optionalDependencies: { 'other-service': '~2.1' } })
  const parsed = validateManifest(input, true)
  assert.deepEqual(parsed.dependencies, input.dependencies)
  assert.deepEqual(parsed.optionalDependencies, input.optionalDependencies)
  assert.deepEqual(parsed.engines, input.engines)
  assert.equal(validateManifest(manifest('test-plugin', { version: 'legacy' })).version, 'legacy')
  assert.throws(() => validateManifest(manifest('test-plugin', { version: 'legacy' }), true), PluginError)
  for (const extra of [
    { engines: { llmhub: 'garbage' } }, { engines: { llmhub: '' } }, { engines: [] },
    { dependencies: [] }, { dependencies: { 'Bad/ID': '*' } },
    { dependencies: { 'text-service': '' } }, { optionalDependencies: { 'text-service': 'garbage' } },
    { entry: '../outside.mjs' }, { ui: { page: '/outside.html' } },
    { ui: null }, { ui: [] }, { ui: 'settings.html' }
  ]) assert.throws(() => validateManifest({ ...manifest(), ...extra }, true), PluginError)
})

test('static extraction accepts literal data and static import forms without resolving imports', () => {
  for (const prefix of [
    '', '// comment\n/* comment */\n', '// comment\r', '// comment\u2028', '// comment\u2029',
    "import 'module-that-does-not-exist';\n",
    "import value from './missing.mjs'\n",
    "import * as namespace from './missing.mjs';",
    "import { named, other as renamed, } from './missing.mjs';",
    "import value, { named } from './missing.mjs';",
    "import value, * as namespace from './missing.mjs';",
    "import { 'non-identifier' as alias } from './missing.mjs';",
    "import 'first'; import { /* export const manifest = fake */ named } from 'second';"
  ]) assert.equal(parseUploadedManifest(prefix + declaration).id, 'test-plugin', prefix)
  const parsed = parseUploadedManifest(`export /* c */ const manifest = {
    id: 'test-plugin', name: 'Test\\x20\\u0041', version: '1.0.0',
    configSchema: [{ key: 'count', type: 'number', default: -1.5e2 },
      { key: 'flag', type: 'boolean', default: true },],
    dependencies: { 'text-service': '^1.0.0' },
  }\nexport default { setup() { throw new Error('must not execute') } }`)
  assert.equal(parsed.name, 'Test A')
  assert.equal(parsed.configSchema[0].default, -150)
  assert.equal(parsed.configSchema[1].default, true)
  assert.equal(parseUploadedManifest(`${declaration}\nglobalThis.uploadManifestExecuted = true;`).id, 'test-plugin')
  assert.equal(Reflect.get(globalThis, 'uploadManifestExecuted'), undefined)
})

test('static extraction rejects executable expressions and fake declarations rather than scanning JavaScript', () => {
  for (const source of [
    `const text = \`${declaration}\`;`,
    `const expression = /${declaration}/;`,
    `function nested() { ${declaration} }`,
    `/* ${declaration} */`, `// ${declaration}`,
    `import(\`${declaration}\`);`,
    `import.meta; ${declaration}`,
    `import { name = \`${declaration}\` } from 'module';`,
    `import 'module' ${declaration}`,
    `globalThis.uploadManifestExecuted = true; ${declaration}`,
    'export const manifest = globalThis.uploadManifestExecuted = true;',
    `export const manifest = { ...${literal} };`,
    `export const manifest = { get id() { throw new Error() } };`,
    `export const manifest = { [globalThis.uploadManifestExecuted = true]: 'test-plugin' };`,
    `export const manifest = ${literal} || (globalThis.uploadManifestExecuted = true);`,
    `export const manifest = ${literal}\nexportedFake`,
    `export const manifest = { id: 'test-plugin', id: 'other-plugin' };`,
    `export const manifest = { __proto__: {} };`,
    `export const manifest = { constructor: {} };`,
    `export const manifest = { name: '\\01' };`,
    `export const manifest = { name: '\\8' };`,
    `export const manifest = { name: '\\uZZZZ' };`,
    `export const manifest = { number: 1e999 };`,
    '/* unterminated', 'export const manifest = {',
    `export const manifest = ${'['.repeat(102)}${']'.repeat(102)};`
  ]) assert.throws(() => parseUploadedManifest(source), PluginError, source)
  assert.equal(Reflect.get(globalThis, 'uploadManifestExecuted'), undefined)
})

test('API compatibility is enforced independently from legacy manifest warnings', () => {
  assert.doesNotThrow(() => assertCompatibility(manifest('test-plugin', { engines: { llmhub: PLUGIN_API_VERSION } })))
  assert.doesNotThrow(() => assertCompatibility(manifest()))
  assert.throws(() => assertCompatibility(manifest('test-plugin', { engines: { llmhub: '<0.0.1' } })), PluginError)
  assert.equal(manifestWarnings(manifest('test-plugin', { version: 'legacy' })).length, 2)
  assert.deepEqual(manifestWarnings(manifest('test-plugin', { engines: { llmhub: '*' } })), [])
})

test('dependency topology is stable, includes installed optional edges and isolates cycles', () => {
  const result = dependencyOrder([
    manifest('consumer', { dependencies: { service: '*' } }),
    manifest('independent'), manifest('service'),
    manifest('optional', { optionalDependencies: { service: '*', missing: '*' } })
  ])
  assert.deepEqual(result.order, ['independent', 'service', 'consumer', 'optional'])
  const cyclic = dependencyOrder([
    manifest('cycle-one', { dependencies: { 'cycle-two': '*' } }),
    manifest('cycle-two', { dependencies: { 'cycle-one': '*' } }),
    manifest('dependent', { dependencies: { 'cycle-one': '*' } }),
    manifest('self-cycle', { dependencies: { 'self-cycle': '*' } }), manifest('independent')
  ])
  assert.deepEqual([...cyclic.cycles.keys()].sort(), ['cycle-one', 'cycle-two', 'self-cycle'])
  assert.deepEqual(cyclic.order, ['dependent', 'independent'])
})

test('required dependencies block on absence, version and availability; optional dependencies only report', () => {
  const consumer = manifest('consumer', { dependencies: { service: '^1.0.0' }, optionalDependencies: { optional: '^1.0.0' } })
  assert.match(dependencyIssues(consumer, [])[0], /not installed/)
  assert.equal(dependencyIssues(consumer, []).length, 1)
  for (const service of [
    record(manifest('service', { version: '2.0.0' })),
    record(manifest('service', { version: 'legacy' })),
    record(manifest('service'), { enabled: false, status: 'disabled' }),
    record(manifest('service'), { status: 'error', error: 'failed' })
  ]) assert.equal(dependencyIssues(consumer, [service]).length, 1)
  const records = [record(consumer), record(manifest('service'))]
  assert.deepEqual(dependencyIssues(consumer, records), [])
  const decorated = decorateRecords(records)
  assert.deepEqual(decorated[1].requiredBy, ['consumer'])
  assert.equal(decorated[0].dependencies.find((dependency: { id: string }) => dependency.id === 'optional').optional, true)
  assert.equal(decorated[0].dependencies.find((dependency: { id: string }) => dependency.id === 'optional').satisfied, false)
})
