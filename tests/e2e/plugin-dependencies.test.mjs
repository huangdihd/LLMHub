import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRegistry } from './npm-registry.mjs'
import { createPluginGateway } from './plugin-gateway.mjs'

// Real npm transactions against an offline registry and an isolated built gateway.
const provider = 'dependency-fixture'
const consumer = 'dependent-fixture'
const fixture = await createRegistry()
let gateway
const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
async function list() {
  const response = await gateway.request('')
  assert.equal(response.status, 200)
  return response.json()
}
async function install(id, version, force) {
  return gateway.request('/install-npm', json('POST', { name: `llmhub-plugin-${id}`, version, ...(force === undefined ? {} : { force }) }))
}
async function value() {
  const response = await gateway.request(`/${consumer}/api/value`)
  assert.equal(response.status, 200)
  return response.json()
}

try {
  for (const version of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) {
    await fixture.add(`llmhub-plugin-${provider}`, version, {
      engines: { llmhub: '^1.0.0' },
      llmhub: { id: provider, configSchema: [{ key: 'prefix', type: 'text', default: 'default' }] }
    }, `export default { async setup(api) {
      ${version === '1.3.0' ? "await api.storage.setItem('token', 'must-rollback'); throw new Error('intentional upgrade failure');" : ''}
      if (!await api.storage.getItem('token')) await api.storage.setItem('token', 'persisted');
      api.provide({ value: '${version}', prefix: () => api.config.prefix, token: () => api.storage.getItem('token') });
    } }`)
  }
  await fixture.add(`llmhub-plugin-${consumer}`, '1.0.0', {
    engines: { llmhub: '^1.0.0' }, llmhub: { id: consumer, dependencies: { [provider]: '^1.0.0' } }
  }, `export default { setup(api) {
    const service = api.require('${provider}');
    api.registerRoute('GET', 'value', async () => ({ value: service.value, prefix: service.prefix(), token: await service.token() }));
  } }`)
  gateway = await createPluginGateway()
  const before = await list()
  for (const plugin of before) assert.equal(plugin.apiVersion, '1.1.0')
  assert.equal((await gateway.request('/registry', json('PUT', { registry: fixture.registry }))).status, 200)
  assert.equal((await install(provider, '1.0.0')).status, 200)
  assert.equal((await gateway.request(`/${provider}/enable`, { method: 'POST' })).status, 200)
  assert.equal((await gateway.request(`/${provider}/config`, json('PUT', { prefix: 'configured' }))).status, 200)
  assert.equal((await install(provider, '1.1.0')).status, 200)
  assert.equal((await install(provider, '1.0.0', false)).status, 400)
  assert.equal((await list()).find(plugin => plugin.id === provider).manifest.version, '1.1.0')
  assert.equal((await install(provider, '1.0.0', 'yes')).status, 400)
  assert.equal((await install(provider, '1.0.0', true)).status, 200)
  assert.equal((await install(consumer, '1.0.0')).status, 200)
  assert.equal((await gateway.request(`/${consumer}/enable`, { method: 'POST' })).status, 200)
  const records = await list()
  assert.ok(records.find(plugin => plugin.id === provider).requiredBy.includes(consumer))
  const dependency = records.find(plugin => plugin.id === consumer).dependencies.find(item => item.id === provider)
  assert.equal(dependency.satisfied, true)
  assert.equal(dependency.version, '1.0.0')
  assert.equal((await gateway.request(`/${provider}/disable`, { method: 'POST' })).status, 400)
  assert.equal((await gateway.request(`/${provider}`, { method: 'DELETE' })).status, 400)
  const expected = version => ({ value: version, prefix: 'configured', token: 'persisted' })
  assert.deepEqual(await value(), expected('1.0.0'))
  assert.equal((await install(provider, '1.2.0')).status, 200)
  assert.deepEqual(await value(), expected('1.2.0'))
  assert.equal((await list()).find(plugin => plugin.id === consumer).enabled, true)
  const projectFile = join(gateway.directory, '.data/plugins/package.json')
  const lockFile = join(gateway.directory, '.data/plugins/package-lock.json')
  const previousProject = await readFile(projectFile, 'utf8')
  const previousLock = await readFile(lockFile, 'utf8')
  assert.equal((await install(provider, '1.3.0')).status, 400)
  assert.deepEqual(await value(), expected('1.2.0'))
  assert.equal((await list()).find(plugin => plugin.id === provider).manifest.version, '1.2.0')
  assert.equal((await list()).find(plugin => plugin.id === consumer).enabled, true)
  assert.equal(await readFile(projectFile, 'utf8'), previousProject)
  assert.equal(await readFile(lockFile, 'utf8'), previousLock)
  for (const id of [consumer, provider]) {
    const response = await gateway.request(`/${id}`, { method: 'DELETE' })
    assert.equal(response.status, 200, await response.text())
    for (const key of ['state', 'source', 'storage/token']) {
      await assert.rejects(access(join(gateway.directory, '.data/runtime-plugins', id, key)), { code: 'ENOENT' })
    }
  }
  assert.ok(!(await list()).some(plugin => [provider, consumer].includes(plugin.id)))
  console.log('ok - API version, npm upgrades, boolean force, dependency exports, reload/removal guards, configuration/storage and rollback')
} finally {
  try { await gateway?.close() } finally { await fixture.close() }
}
