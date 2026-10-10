import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import * as vue from 'vue'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const baselineRevision = process.env.DASHBOARD_BASELINE || '60197062a94bb282149e5d6ecb2f8ec2fecbff9d'
const apiModules = ['access-control', 'quota', 'fallback', 'stats'].map(name => `builtin/${name}/dashboard-api-key.ts`)
const sectionModules = ['rate-limit', 'access-control', 'token-billing'].map(name => `builtin/${name}/dashboard-sections.ts`)

// Execute the actual TypeScript sessions and page scripts, without Nuxt or a browser.
function harness(fetch) {
  const notifications = []
  const navigations = []
  const mounted = []
  const cache = new Map()
  const globals = {
    $fetch: fetch,
    useToast: () => ({ add: message => notifications.push(message) }),
    navigateTo: destination => { navigations.push(destination) },
    console,
    navigator: { clipboard: { writeText: async () => {} } },
    confirm: () => true
  }
  function execute(source, filename, extra = {}) {
    const module = { exports: {} }
    const javascript = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    const localRequire = name => {
      if (name === 'vue') return { ...vue, onMounted: callback => mounted.push(callback) }
      if (name === '#imports') return globals
      if (name.endsWith('.vue')) return { default: {} }
      if (name.startsWith('.')) return load(resolve(dirname(filename), name))
      return require(name)
    }
    vm.runInNewContext(javascript, { ...globals, ...extra, module, exports: module.exports, require: localRequire }, { filename })
    return module.exports
  }
  function load(filename) {
    filename = resolve(root, filename)
    if (!filename.endsWith('.ts')) filename += '.ts'
    if (cache.has(filename)) return cache.get(filename)
    let source = readFileSync(filename, 'utf8')
    const extra = {}
    if (source.includes('import.meta.glob')) {
      const paths = filename.endsWith('useApiKeyDashboard.ts') ? apiModules : sectionModules
      source = source.replace(/import\.meta\.glob<[^\n]+/u, '__modules')
      extra.__modules = Object.fromEntries(paths.map(path => [path, load(path)]))
    }
    const result = execute(source, filename, extra)
    cache.set(filename, result)
    return result
  }
  globals.useApiKeyDashboard = () => load('composables/useApiKeyDashboard.ts').useApiKeyDashboard()
  globals.useDashboardSections = page => load('composables/useDashboardSections.ts').useDashboardSections(page)
  function page(name, baseline = false) {
    const filename = `pages/${name}.vue`
    const source = baseline ? execFileSync('git', ['show', `${baselineRevision}:${filename}`], { cwd: root, encoding: 'utf8' }) : readFileSync(resolve(root, filename), 'utf8')
    const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/u)[1]
    const exports = {
      'api-keys': 'keys, loading, saving, form, newKeyPlain, openCreateModal, openEditModal, closeModal, saveKey',
      models: 'models, loading, loadAll, refreshModels',
      security: 'config, loadConfig, saveConfig'
    }[name]
    // The script-only harness has no renderer to mount the runtime field editor.
    // Supply the empty-contribution component contract; existing payload assertions stay unchanged.
    const mountFields = !baseline && name === 'api-keys'
      ? '\ncontributionFields.value = { validate: () => true, save: async () => {} }'
      : ''
    return execute(`${script}${mountFields}\nexport { ${exports} }`, resolve(root, filename))
  }
  return { load, page, mounted, notifications, navigations }
}
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

for (const baseline of [true, false]) {
  const label = baseline ? 'pre-split' : 'extracted'
  test(`${label}: API-key initial publication waits for catalog loads`, async () => {
    const providers = deferred()
    const environment = harness(url => {
      if (url.endsWith('/providers')) return providers.promise
      return Promise.resolve(url.endsWith('/keys') ? { keys: [{ id: 'one' }] } : { models: [] })
    })
    const page = environment.page('api-keys', baseline)
    const loading = environment.mounted[0]()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(plain(page.keys.value), [])
    assert.equal(page.loading.value, true)
    providers.resolve({ providers: [] })
    await loading
    assert.deepEqual(plain(page.keys.value), [{ id: 'one' }])
    assert.equal(page.loading.value, false)
  })

  test(`${label}: models wait for ratios and refresh reuses the loaded ratios`, async () => {
    const ratios = deferred()
    const requests = []
    const environment = harness((url, options) => {
      requests.push([url, options?.method])
      if (url.endsWith('/model-token-ratios')) return ratios.promise
      if (url.endsWith('/providers')) return Promise.reject(new Error('optional catalog unavailable'))
      return Promise.resolve({ models: [{ id: 'a/one', provider: 'a' }] })
    })
    const page = environment.page('models', baseline)
    const loading = page.loadAll()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(plain(page.models.value), [])
    ratios.resolve({ ratios: { 'a/one': { input: 0.5, output: 2, cached: 0 } } })
    await loading
    assert.deepEqual(plain(page.models.value[0].tokenRatios), { input: '50', output: '200', cached: '0' })
    await page.refreshModels()
    assert.deepEqual(requests.slice(-2), [['/api/hub/models/refresh', 'POST'], ['/api/hub/models', undefined]])
    assert.equal(requests.filter(([url]) => url.endsWith('/model-token-ratios')).length, 1)
    assert.deepEqual(plain(page.models.value[0].tokenRatios), { input: '50', output: '200', cached: '0' })
  })

  test(`${label}: security saves login and rate-limit settings together, not SSRF`, async () => {
    const requests = []
    const environment = harness(async (url, options) => {
      if (options) requests.push([url, plain(options)])
      return { bruteForce: { enabled: true, max_attempts: 8, lockout_minutes: 20, ip_header: 'x-real-ip', rate_limit_enabled: true, rate_limit_max_rpm: 70 }, ssrf: { enabled: true, allowed_hosts: ['example.org'] } }
    })
    const page = environment.page('security', baseline)
    await page.loadConfig()
    page.config.max_attempts = 9
    await page.saveConfig()
    assert.deepEqual(requests, [['/api/hub/security', { method: 'PUT', body: { bruteForce: {
      enabled: true, max_attempts: 9, lockout_minutes: 20, ip_header: 'x-real-ip', rate_limit_enabled: true, rate_limit_max_rpm: 70
    } } }]])
  })

  test(`${label}: create POST precedes policy PUT, plaintext persists until close`, async () => {
    const requests = []
    const environment = harness(async (url, options) => {
      requests.push([url, plain(options || {})])
      if (options?.method === 'POST') return { key: { id: 'new', plain_key: 'test-only-key' } }
      return { keys: [] }
    })
    const page = environment.page('api-keys', baseline)
    page.openCreateModal()
    page.form.name = 'Example'
    await page.saveKey()
    assert.deepEqual(requests, [
      ['/api/hub/keys', { method: 'POST', body: { name: 'Example' } }],
      ['/api/hub/keys/new', { method: 'PUT', body: {
        name: 'Example', monthly_limit: 0, allowed_providers: [], allowed_models: [],
        model_quotas: {}, provider_quotas: {}, fallback_strategy: { enabled: false, name: 'auto', priority: [] }
      } }]
    ])
    assert.equal(page.newKeyPlain.value, 'test-only-key')
    page.closeModal()
    assert.equal(page.newKeyPlain.value, '')
    assert.equal(requests[2][0], '/api/hub/keys')
  })

  test(`${label}: a failed create policy PUT keeps the new plaintext and clears busy state`, async () => {
    const environment = harness(async (url, options) => {
      if (options?.method === 'POST') return { key: { id: 'new', plain_key: 'test-only-key' } }
      throw { statusCode: 401 }
    })
    const page = environment.page('api-keys', baseline)
    page.openCreateModal()
    await page.saveKey()
    assert.equal(page.newKeyPlain.value, 'test-only-key')
    assert.equal(page.saving.value, false)
    assert.deepEqual(environment.navigations, ['/login'])
  })

  test(`${label}: edit policy payload preserves priority and ignores nonpositive quotas`, async () => {
    const requests = []
    const environment = harness(async (url, options) => { requests.push([url, plain(options || {})]); return { keys: [] } })
    const page = environment.page('api-keys', baseline)
    const record = { id: 'edit', name: 'Edited', created_at: '', monthly_limit: 90,
      allowed_providers: ['b', 'a'], allowed_models: ['b/two', 'a/one'],
      model_quotas: { zero: 0, negative: -1, 'b/two': 50 }, provider_quotas: { b: 25, a: 0 },
      fallback_strategy: { enabled: true, name: '', priority: ['b/two', '', 'a/one', 'b/two'] } }
    page.openEditModal(record)
    await page.saveKey()
    assert.deepEqual(requests[0], ['/api/hub/keys/edit', { method: 'PUT', body: {
      name: 'Edited', monthly_limit: 90, allowed_providers: ['b', 'a'], allowed_models: ['b/two', 'a/one'],
      model_quotas: { 'b/two': 50 }, provider_quotas: { b: 25 },
      fallback_strategy: { enabled: true, name: 'auto', priority: ['b/two', 'a/one', 'b/two'] }
    } }])
    assert.equal(requests[1][0], '/api/hub/keys')
    assert.equal(record.fallback_strategy.name, '')
  })
}

test('API-key sessions share reactive catalogs but isolate page state and copied selections', async () => {
  const environment = harness(async url => url.endsWith('/providers')
    ? { providers: [{ name: 'a', display_name: 'A' }, { name: 'b', display_name: 'B' }] }
    : { models: [{ id: 'a/one', name: 'One', provider: 'a' }, { id: 'b/two', name: 'Two', provider: 'b' }] })
  const create = environment.load('composables/useApiKeyDashboard.ts').useApiKeyDashboard
  const first = create()
  const second = create()
  await first.load()
  const record = { allowed_providers: ['b'], allowed_models: ['b/two'], fallback_strategy: { priority: ['b/two'] } }
  first.reset(record)
  const editors = first.sections('editor').map(section => section.props())
  const access = editors.find(properties => properties.form.selectedProviders)
  const quota = editors.find(properties => properties.form.modelQuotaList && properties.catalog)
  const fallback = editors.find(properties => properties.form.fallbackPriority)
  assert.equal(access.catalog, quota.catalog)
  assert.equal(access.catalog, fallback.catalog)
  assert.deepEqual(plain(access.catalog.filteredModelOptions.value.map(model => model.id)), ['b/two'])
  access.form.selectedProviders.push('a')
  fallback.form.fallbackPriority.push('a/one')
  assert.deepEqual(record.allowed_providers, ['b'])
  assert.deepEqual(record.fallback_strategy.priority, ['b/two'])
  assert.equal(access.catalog.filteredModelOptions.value.length, 2)
  assert.deepEqual(plain(second.payload().allowed_providers), [])
  first.reset()
  assert.deepEqual(plain(first.payload().fallback_strategy), { enabled: false, name: 'auto', priority: [] })
})

test('security sessions hydrate defaults, keep SSRF out of login payload, trim hosts and recover from 401', async () => {
  const requests = []
  let failure
  const environment = harness(async (url, options) => {
    requests.push([url, plain(options)])
    if (failure) throw failure
    return {}
  })
  const dashboard = environment.load('composables/useDashboardSections.ts').useDashboardSections('security')
  dashboard.hydrate({ bruteForce: { rate_limit_enabled: true, rate_limit_max_rpm: 42 }, ssrf: { enabled: true, allowed_hosts: ['a.example'] } })
  assert.deepEqual(plain(dashboard.payload()), { rate_limit_enabled: true, rate_limit_max_rpm: 42 })
  const section = dashboard.sections('after-login')[0]
  const properties = section.props()
  assert.equal(properties.allowedHostsText, 'a.example')
  properties['onUpdate:allowedHostsText']('  b.example \n\n c.example\n b.example ')
  const saving = properties.saveSSRFConfig()
  assert.equal(section.props().savingSSRF, true)
  await saving
  assert.deepEqual(requests[0], ['/api/hub/security', { method: 'PUT', body: { ssrf: { enabled: true, allowed_hosts: ['b.example', 'c.example', 'b.example'] } } }])
  failure = { statusCode: 401 }
  await properties.saveSSRFConfig()
  assert.deepEqual(environment.navigations, ['/login'])
  assert.equal(section.props().savingSSRF, false)
  dashboard.hydrate({})
  assert.deepEqual(plain(dashboard.payload()), { rate_limit_enabled: false, rate_limit_max_rpm: 0 })
  assert.equal(section.props().allowedHostsText, '')
})

test('billing ratios preserve other models, remove defaults, validate input and reset busy state', async () => {
  const requests = []
  let failure
  const environment = harness(async (url, options) => {
    if (!options) return { ratios: { other: { input: 2, output: 3, cached: 0 } } }
    requests.push(plain(options.body))
    if (failure) throw failure
    return { settings: options.body }
  })
  const dashboard = environment.load('composables/useDashboardSections.ts').useDashboardSections('models')
  await dashboard.load()
  const model = dashboard.decorate({ id: 'target' })
  const section = dashboard.sections('model-actions')[0]
  const actions = section.props(model)
  assert.deepEqual(plain(model.tokenRatios), { input: '100', output: '100', cached: '100' })
  assert.equal(actions.isRatioDirty(model), false)
  model.tokenRatios.input = '0'
  const saving = actions.saveRatios(model)
  assert.equal(section.props(model).savingRatio, 'target')
  await saving
  assert.equal(actions.isRatioDirty(model), false)
  assert.deepEqual(requests[0], { ratios: { other: { input: 2, output: 3, cached: 0 }, target: { input: 0, output: 1, cached: 1 } } })
  model.tokenRatios.input = '100'
  await actions.saveRatios(model)
  assert.deepEqual(requests[1], { ratios: { other: { input: 2, output: 3, cached: 0 } } })
  for (const invalid of ['NaN', 'Infinity', '-1', '10001']) {
    model.tokenRatios.input = invalid
    await actions.saveRatios(model)
  }
  assert.equal(requests.length, 2)
  model.tokenRatios.input = '200'
  failure = { statusCode: 401 }
  await actions.saveRatios(model)
  assert.deepEqual(environment.navigations, ['/login'])
  assert.equal(section.props(model).savingRatio, '')
  assert.equal(actions.isRatioDirty(model), true)
})
