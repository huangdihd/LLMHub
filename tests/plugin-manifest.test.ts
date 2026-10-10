import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import type { PluginManifest, PluginRecord } from '../shared/types/plugin.ts'

const require = createRequire(import.meta.url)
const buildDirectory = process.env.ADAPTER_BUILD
if (!buildDirectory) throw new Error('Run through tests/run-all.sh')
const { validateManifest, PluginError } = require(`${buildDirectory}/plugins-runtime/manifest.js`)
const { parseUploadedManifest } = require(`${buildDirectory}/plugins-runtime/upload-manifest.js`)
const { assertCompatibility, manifestWarnings, dependencyOrder, dependencyIssues, decorateRecords } = require(`${buildDirectory}/plugins-runtime/dependencies.js`)
const { PLUGIN_API_VERSION } = require(`${buildDirectory}/core/plugin-version.js`)

const manifest = (id = 'test-plugin', extra: Partial<PluginManifest> = {}): PluginManifest => ({ id, name: id, version: '1.0.0', ...extra })
const literal = "{ id: 'test-plugin', name: 'Test', version: '1.0.0' }"
const declaration = `export const manifest = ${literal};`
const record = (value: PluginManifest, extra: Partial<PluginRecord> = {}): PluginRecord => ({ id: value.id, manifest: value, enabled: true, status: 'enabled', providers: [], hooks: [], ...extra })

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
    { entry: '../outside.mjs' }, { ui: { page: '/outside.html' } }
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
