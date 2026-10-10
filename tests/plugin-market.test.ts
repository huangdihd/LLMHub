import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { after, test } from 'node:test'

// This module is intentionally independent of manager compilation, so registry tests stay offline.
const build = mkdtempSync(resolve(tmpdir(), 'llmhub-market-tests-'))
after(() => rmSync(build, { recursive: true, force: true }))
execFileSync(resolve('node_modules/.bin/tsc'), [
  'server/plugins-runtime/market.ts', '--rootDir', '.', '--outDir', build,
  '--module', 'commonjs', '--target', 'es2022', '--moduleResolution', 'node',
  '--esModuleInterop', '--skipLibCheck', '--strict'
], { stdio: 'pipe' })
writeFileSync(resolve(build, 'package.json'), '{"type":"commonjs"}')
symlinkSync(resolve('node_modules'), resolve(build, 'node_modules'), 'dir')
const require = createRequire(import.meta.url)
const { PluginMarket, MARKET_README_LIMIT, safeMarketLink } = require(resolve(build, 'server/plugins-runtime/market.js'))

async function fixture() {
  const requests: URL[] = []
  let mode = 'normal'
  let records: unknown[] = []
  let compatibilityRange: unknown
  let releaseResponse: (() => void) | undefined
  let delayedResponse: ReturnType<typeof setTimeout> | undefined
  const packages = [
    { name: '@demo/llmhub-plugin-a', version: '2.0.0', keywords: ['llmhub-plugin'], date: '2026-01-01', engines: { llmhub: '^1.0.0' }, llmhub: { id: 'demo' }, links: { homepage: 'javascript:alert(1)', npm: 'https://www.npmjs.com/package/demo' } },
    { name: 'llmhub-plugin-z', version: '1.0.0', date: '2026-02-01' }
  ]
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://registry.test')
    requests.push(url)
    if (mode === 'held') { releaseResponse = () => response.end(JSON.stringify({ objects: [], total: 0 })); return }
    if (mode === 'held-search' && url.pathname.endsWith('/-/v1/search')) {
      releaseResponse = () => response.end(JSON.stringify({ objects: [{ package: packages[1] }], total: 1 }))
      return
    }
    if (mode === 'unsupported') { response.writeHead(404).end(); return }
    if (mode === 'failure') { response.writeHead(503).end(); return }
    if (mode === 'redirect') { response.writeHead(302, { location: 'http://127.0.0.1/private' }).end(); return }
    if (mode === 'slow') { delayedResponse = setTimeout(() => response.end('{}'), 200); return }
    if (mode === 'slow-body') { response.writeHead(200); response.write('{'); delayedResponse = setTimeout(() => response.end('}'), 200); return }
    if (mode === 'invalid') { response.end('<html>no</html>'); return }
    if (mode === 'large') { response.end('x'.repeat(4 * 1024 * 1024 + 1)); return }
    if (mode === 'malformed') { response.end(JSON.stringify({ objects: {}, total: 2 })); return }
    response.setHeader('Content-Type', 'application/json')
    if (mode === 'compatibility' && !url.pathname.endsWith('/-/v1/search')) {
      response.end(JSON.stringify({ name: packages[0]!.name, 'dist-tags': { latest: '2.0.0' }, versions: { '2.0.0': { ...packages[0], engines: { llmhub: compatibilityRange } } } }))
      return
    }
    if (url.pathname.endsWith('/-/v1/search')) {
      const selected = mode === 'paginated' ? packages.slice(Number(url.searchParams.get('from')), Number(url.searchParams.get('from')) + Number(url.searchParams.get('size'))) : packages
      response.end(JSON.stringify({ objects: selected.map(metadata => ({ package: metadata })), total: mode === 'paginated' ? packages.length : 25 }))
      return
    }
    if (mode === 'enrichment-failure') { response.writeHead(503).end(); return }
    if (mode === 'incomplete-detail') { response.end(JSON.stringify({ name: packages[1]!.name })); return }
    if (mode === 'dependencies') {
      response.end(JSON.stringify({ name: packages[0]!.name, 'dist-tags': { latest: '2.0.0' }, versions: { '2.0.0': { ...packages[0], llmhub: { dependencies: { ready: '^1', disabled: '^1', failed: '^1', outdated: '^2', missing: '^1', invalid: 'bad' }, optionalDependencies: { optional: '*' } } } } }))
      return
    }
    if (url.pathname.endsWith('/llmhub-plugin-z')) {
      response.end(JSON.stringify({ name: packages[1]!.name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': packages[1] } }))
      return
    }
    response.end(JSON.stringify({ name: packages[0]!.name, 'dist-tags': { latest: '2.0.0' }, versions: { '2.0.0': { ...packages[0], license: 'MIT', author: { name: 'Author' }, repository: { url: 'https://example.com/source' }, engines: { llmhub: '>=2' } } }, readme: '<script>unsafe()</script>\n# Markdown\n' + '中'.repeat(MARKET_README_LIMIT), time: { '2.0.0': '2026-01-01' } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  let registry = `http://127.0.0.1:${address.port}/registry/`
  const manager = { getRegistry: async () => registry, list: () => records }
  const options = { manager, getSSRFConfig: async () => ({ enabled: false, allowed_hosts: [] }), validateRegistry: async () => {}, timeoutMs: 80 }
  return {
    requests, manager, options, market: new PluginMarket(options),
    release() { releaseResponse?.() },
    setCompatibilityRange(value: unknown) { compatibilityRange = value },
    setMode(value: string) { mode = value }, setRecords(value: unknown[]) { records = value }, setRegistry(value: string) { registry = value },
    async close() { clearTimeout(delayedResponse); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  }
}

test('standard npm search, scoped names, pagination, sorting, cache and live installation state', async () => {
  const context = await fixture()
  try {
    const first = await context.market.search({ query: 'hello', page: 2, pageSize: 2, sort: 'downloads' })
    const request = context.requests[0]!
    assert.equal(request.pathname, '/registry/-/v1/search')
    assert.equal(request.searchParams.get('text'), 'hello keywords:llmhub-plugin')
    assert.equal(request.searchParams.get('from'), '2')
    assert.equal(request.searchParams.get('size'), '2')
    assert.equal(request.searchParams.get('popularity'), '1')
    assert.equal(first.total, 25)
    assert.equal(first.items[0].installed, false)
    assert.equal(first.items[0].compatibility, 'compatible')
    assert.equal(first.items[1].compatibility, 'unknown')
    assert.equal(first.items[0].links.homepage, undefined)
    context.setRecords([{ id: 'demo', manifest: { version: '1.0.0' }, source: { type: 'npm', packageName: '@demo/llmhub-plugin-a' } }])
    const cached = await context.market.search({ query: 'hello', page: 2, pageSize: 2, sort: 'downloads' })
    assert.equal(context.requests.length, 2)
    assert.equal(cached.items[0].installedVersion, '1.0.0')
    assert.equal(cached.items[0].updateAvailable, true)
    const updated = await context.market.search({ sort: 'updated' })
    assert.equal(updated.items[0].name, 'llmhub-plugin-z')
    assert.equal(updated.sortScope, 'page')
    assert.ok(context.market.clearCache().cleared >= 2)
    await context.market.search({ query: 'hello', page: 2, pageSize: 2, sort: 'downloads' })
    assert.equal(context.requests.length, 5)
  } finally { await context.close() }
})

test('detail preserves raw Markdown with bounded UTF-8, compatibility and safe links', async () => {
  const context = await fixture()
  try {
    const detail = await context.market.detail('@demo/llmhub-plugin-a')
    assert.equal(context.requests[0]!.pathname, '/registry/%40demo%2Fllmhub-plugin-a')
    assert.equal(detail.compatibility, 'incompatible')
    assert.equal(detail.author, 'Author')
    assert.equal(detail.license, 'MIT')
    assert.equal(detail.links.repository, 'https://example.com/source')
    assert.ok(detail.readme.startsWith('<script>unsafe()</script>\n# Markdown'))
    assert.ok(Buffer.byteLength(detail.readme) <= MARKET_README_LIMIT)
    assert.ok(!detail.readme.includes('\uFFFD'))
    assert.equal(detail.readmeTruncated, true)
    assert.deepEqual(detail.versions, ['2.0.0'])
    for (const value of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://user:secret@example.com', '//example.com']) assert.equal(safeMarketLink(value), undefined)
    assert.equal(safeMarketLink('http://example.com'), 'http://example.com/')
  } finally { await context.close() }
})

test('cache is registry-keyed and explicit clearing cannot resurrect in-flight data', async () => {
  const context = await fixture()
  try {
    await context.market.search()
    context.setRegistry((await context.manager.getRegistry()).replace('/registry/', '/other/'))
    await context.market.search()
    assert.equal(context.requests.length, 4)
    assert.ok(context.market.clearCache().cleared >= 2)
    context.setMode('held')
    const pending = context.market.search()
    while (context.requests.length < 5) await new Promise(resolve => setTimeout(resolve, 1))
    context.market.clearCache()
    context.release()
    await pending
    context.setMode('normal')
    await context.market.search()
    assert.equal(context.requests.length, 7)
    const uncached = new PluginMarket({ ...context.options, cacheTtlMs: 0 })
    await uncached.search()
    await uncached.search()
    assert.equal(context.requests.length, 11)
  } finally { await context.close() }
})

test('unsupported search, failures, invalid responses, oversize bodies, redirects and timeouts are explicit', async () => {
  for (const [mode, code] of [
    ['unsupported', 'SEARCH_UNSUPPORTED'], ['failure', 'REGISTRY_ERROR'], ['invalid', 'INVALID_RESPONSE'],
    ['malformed', 'INVALID_RESPONSE'], ['large', 'RESPONSE_TOO_LARGE'], ['redirect', 'REGISTRY_UNAVAILABLE'],
    ['slow', 'REGISTRY_TIMEOUT'], ['slow-body', 'REGISTRY_TIMEOUT']
  ]) {
    const context = await fixture()
    try {
      context.setMode(mode!)
      await assert.rejects(context.market.search(), { code })
      context.setMode('normal')
      await context.market.search()
      assert.equal(context.requests.length, 3, `${mode} must not be cached or retried`)
    } finally { await context.close() }
  }
})

test('validates input and blocks private registries in production before any request', async () => {
  const context = await fixture()
  try {
    for (const options of [{ page: 0 }, { pageSize: 101 }, { sort: 'evil' }, { query: 'x'.repeat(201) }]) {
      await assert.rejects(context.market.search(options), { code: 'INVALID_SEARCH' })
    }
    for (const name of ['.', '..', '../secret', 'https://evil.test', '@scope', '@scope/a/b']) await assert.rejects(context.market.detail(name), { code: 'INVALID_PACKAGE' })
    const production = new PluginMarket({ ...context.options, validateRegistry: undefined })
    for (const registry of ['http://127.0.0.1', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://[fc00::1]', 'http://100.64.0.1', 'http://192.0.2.1', 'http://198.51.100.1', 'http://203.0.113.1', 'http://[2001:db8::1]', 'http://[2001:1ff::1]', 'http://[2002:7f00:1::]', 'http://[3fff::1]', 'http://[3fff:fff::1]']) {
      context.setRegistry(registry)
      await assert.rejects(production.search(), { code: 'REGISTRY_BLOCKED' })
    }
    for (const registry of ['file:///etc', 'https://user:secret@example.com', 'https://example.com?url=x']) {
      context.setRegistry(registry)
      await assert.rejects(context.market.search(), { code: 'INVALID_REGISTRY' })
    }
    assert.equal(context.requests.length, 0)
  } finally { await context.close() }
})

test('optional enrichment failures preserve searchable results and detail revalidates cached metadata', async () => {
  const context = await fixture()
  try {
    context.setMode('enrichment-failure')
    const result = await context.market.search()
    assert.equal(result.items.length, 2)
    assert.equal(result.items[1].metadataUnavailable, true)
    assert.equal(result.items[1].compatibility, 'unknown')
    context.market.clearCache()
    context.setMode('incomplete-detail')
    const incomplete = await context.market.search()
    assert.equal(incomplete.items[1].metadataUnavailable, true)
    await assert.rejects(context.market.detail('llmhub-plugin-z'), { code: 'INVALID_RESPONSE' })
  } finally { await context.close() }
})

test('policy loading is timeout-bounded and DNS rebinding is blocked at the socket lookup', async () => {
  const context = await fixture()
  const dns = require('node:dns/promises')
  const originalLookup = dns.lookup
  try {
    const stalled = new PluginMarket({ ...context.options, getSSRFConfig: () => new Promise(() => {}) })
    await assert.rejects(stalled.search(), { code: 'REGISTRY_TIMEOUT' })
    const stalledRegistry = new PluginMarket({ ...context.options, manager: { ...context.manager, getRegistry: () => new Promise(() => {}) } })
    await assert.rejects(stalledRegistry.search(), { code: 'REGISTRY_TIMEOUT' })
    let lookups = 0
    dns.lookup = async () => [{ address: ++lookups === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]
    context.setRegistry('http://registry.test')
    const production = new PluginMarket({ ...context.options, validateRegistry: undefined })
    await assert.rejects(production.search(), { code: 'REGISTRY_BLOCKED' })
    assert.equal(lookups, 2)
    assert.equal(context.requests.length, 0)
    // Ordinary 2001:: global-unicast addresses are public, unlike the special-use /23.
    lookups = 0
    dns.lookup = async () => [{ address: ++lookups === 1 ? '2001:4860:4860::8888' : '127.0.0.1', family: lookups === 1 ? 6 : 4 }]
    await assert.rejects(production.search(), { code: 'REGISTRY_BLOCKED' })
    assert.equal(lookups, 2, 'public IPv6 must pass initial validation and reach the checked socket lookup')
  } finally { dns.lookup = originalLookup; await context.close() }
})

test('detail separates npm dependencies from required and optional plugin dependency health', async () => {
  const context = await fixture()
  try {
    context.setMode('dependencies')
    context.setRecords([
      { id: 'ready', builtin: true, enabled: true, status: 'enabled', manifest: { version: '1.2.0' } },
      { id: 'disabled', enabled: false, status: 'disabled', manifest: { version: '1.2.0' } },
      { id: 'failed', enabled: true, status: 'error', manifest: { version: '1.2.0' } },
      { id: 'outdated', enabled: true, status: 'enabled', manifest: { version: '1.2.0' } }
    ])
    const detail = await context.market.detail('@demo/llmhub-plugin-a')
    const release = detail.releases[0]
    assert.deepEqual(release.dependencies, {})
    assert.equal(release.pluginDependencies.ready, '^1')
    assert.equal(release.optionalPluginDependencies.optional, '*')
    for (const dependency of release.dependencyStatus) {
      assert.equal(dependency.satisfied, dependency.id === 'ready', dependency.id)
      assert.equal(dependency.optional, dependency.id === 'optional', dependency.id)
      assert.equal(dependency.builtin, dependency.id === 'ready', dependency.id)
      assert.equal(typeof dependency.reason, dependency.satisfied ? 'undefined' : 'string')
    }
    context.setRecords([])
    const cached = await context.market.detail('@demo/llmhub-plugin-a')
    assert.equal(cached.releases[0].dependencyStatus.every((dependency: { satisfied: boolean }) => !dependency.satisfied), true)
    assert.equal(context.requests.length, 1)
  } finally { await context.close() }
})

test('compatibility evaluates the original range, never a truncated or blank range', async () => {
  const context = await fixture()
  try {
    context.setMode('compatibility')
    for (const [range, expected] of [
      [' '.repeat(256) + '>=2', 'incompatible'],
      ['^1' + ' '.repeat(256) + 'invalid', 'unknown'],
      ['   ', 'unknown'],
      ['^1.0.0 || >=2', 'compatible']
    ]) {
      context.market.clearCache()
      context.setCompatibilityRange(range)
      const detail = await context.market.detail('@demo/llmhub-plugin-a')
      assert.equal(detail.compatibility, expected)
    }
  } finally { await context.close() }
})

test('registry pagination returns distinct pages and an empty terminal page without enrichment', async () => {
  const context = await fixture()
  try {
    context.setMode('paginated')
    const first = await context.market.search({ page: 1, pageSize: 1, sort: 'name' })
    const second = await context.market.search({ page: 2, pageSize: 1, sort: 'name' })
    const last = await context.market.search({ page: 3, pageSize: 1 })
    assert.deepEqual(first.items.map((item: { name: string }) => item.name), ['@demo/llmhub-plugin-a'])
    assert.deepEqual(second.items.map((item: { name: string }) => item.name), ['llmhub-plugin-z'])
    assert.deepEqual(last.items, [])
    assert.equal(last.total, 2)
    assert.equal(context.requests.length, 4)
    assert.deepEqual(context.requests.filter(url => url.pathname.endsWith('/-/v1/search')).map(url => url.searchParams.get('from')), ['0', '1', '2'])
  } finally { await context.close() }
})

test('shared outbound wrapper supports injected transport retries and abort deadlines', async () => {
  const { fetchWithRetry } = require(resolve(build, 'server/utils/fetch.js'))
  let attempts = 0
  const response = await fetchWithRetry('https://registry.test/', {
    maxRetries: 1, retryDelay: 0,
    transport: async (address: string, options: RequestInit & { transport?: unknown }) => {
      assert.equal(address, 'https://registry.test/')
      assert.ok(options.signal instanceof AbortSignal)
      assert.equal(options.transport, undefined)
      return new Response(null, { status: ++attempts === 1 ? 503 : 200 })
    }
  })
  assert.equal(response.status, 200)
  assert.equal(attempts, 2)
  await assert.rejects(fetchWithRetry('https://registry.test/', {
    timeout: 5, maxRetries: 0,
    transport: (_address: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
    })
  }), { name: 'AbortError' })
})

test('market uses the shared outbound wrapper with a pinned transport and no implicit retries', async () => {
  const wrapper = require(resolve(build, 'server/utils/fetch.js'))
  const originalFetch = wrapper.fetchWithRetry
  const context = await fixture()
  let calls = 0
  try {
    wrapper.fetchWithRetry = (address: string, options: { transport: unknown; maxRetries: number; timeout: number; redirect: string }) => {
      calls++
      assert.equal(typeof options.transport, 'function')
      assert.equal(options.maxRetries, 0)
      assert.equal(options.timeout, context.options.timeoutMs)
      assert.equal(options.redirect, 'manual')
      return originalFetch(address, options)
    }
    await context.market.search()
    assert.equal(calls, 2)
  } finally { wrapper.fetchWithRetry = originalFetch; await context.close() }
})

test('cached results recheck policy and package identity cannot be spoofed by a plugin ID', async () => {
  const context = await fixture()
  try {
    let blocked = false
    const { PluginMarketError } = require(resolve(build, 'server/plugins-runtime/market.js'))
    const market = new PluginMarket({ ...context.options, validateRegistry: async () => {
      if (blocked) throw new PluginMarketError('REGISTRY_BLOCKED', 'Blocked', 400)
    } })
    context.setRecords([{ id: 'demo', manifest: { version: '1.0.0' }, source: { type: 'npm', packageName: 'other-package' } }])
    const result = await market.search()
    assert.equal(result.items[0].installed, false)
    assert.equal(result.items[0].updateAvailable, false)
    blocked = true
    await assert.rejects(market.search(), { code: 'REGISTRY_BLOCKED' })
    assert.equal(context.requests.length, 2, 'cached data must not bypass a changed policy')
  } finally { await context.close() }
})

test('DNS answers containing both public and private addresses are rejected before connecting', async () => {
  const context = await fixture()
  const dns = require('node:dns/promises')
  const originalLookup = dns.lookup
  try {
    context.setRegistry('http://registry.test/')
    const mixed = [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]
    for (const rebind of [false, true]) {
      let lookups = 0
      dns.lookup = async () => ++lookups === 1 && rebind ? mixed.slice(0, 1) : mixed
      const market = new PluginMarket({ ...context.options, validateRegistry: undefined })
      await assert.rejects(market.search(), { code: 'REGISTRY_BLOCKED' })
      assert.equal(lookups, rebind ? 2 : 1)
    }
    assert.equal(context.requests.length, 0)
  } finally { dns.lookup = originalLookup; await context.close() }
})

test('clearing cache also excludes subsequent enrichment from an already running search', async () => {
  const context = await fixture()
  try {
    context.setMode('held-search')
    const pending = context.market.search()
    while (!context.requests.length) await new Promise(resolve => setTimeout(resolve, 1))
    context.market.clearCache()
    context.release()
    const result = await pending
    assert.equal(result.items[0].metadataUnavailable, false)
    assert.equal(context.requests.length, 2)
    assert.equal(context.market.clearCache().cleared, 0, 'an invalidated search must not repopulate cache through enrichment')
  } finally { await context.close() }
})

test('market honors shared host allowlist semantics without granting private-address exemptions', async () => {
  const context = await fixture()
  const dns = require('node:dns/promises')
  const originalLookup = dns.lookup
  const { validateBaseUrl } = require(resolve(build, 'server/utils/validate-url.js'))
  try {
    let lookups = 0
    dns.lookup = async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }] }
    for (const configuration of [
      { enabled: false, allowed_hosts: ['elsewhere.test'] },
      { enabled: true, allowed_hosts: ['registry.test'] },
      { enabled: true, allowed_hosts: ['test'] }
    ]) {
      context.setRegistry('http://registry.test/')
      assert.equal(validateBaseUrl(await context.manager.getRegistry(), configuration).valid, true)
      const production = new PluginMarket({ ...context.options, validateRegistry: undefined, getSSRFConfig: async () => configuration })
      const previous = lookups
      await assert.rejects(production.search(), { code: 'REGISTRY_BLOCKED' })
      assert.equal(lookups, previous + 1, 'permitted host must reach DNS validation, which still rejects private addresses')
      context.setRegistry('http://127.0.0.1/')
      assert.equal(validateBaseUrl(await context.manager.getRegistry(), configuration).valid, false)
      await assert.rejects(production.search(), { code: 'REGISTRY_BLOCKED' })
      assert.equal(lookups, previous + 1)
    }
    context.setRegistry('http://registry.test/')
    const production = new PluginMarket({ ...context.options, validateRegistry: undefined,
      getSSRFConfig: async () => ({ enabled: true, allowed_hosts: ['other.test'] }) })
    const previous = lookups
    await assert.rejects(production.search(), { code: 'REGISTRY_BLOCKED' })
    assert.equal(lookups, previous, 'disallowed hosts must be blocked before DNS')
    assert.equal(context.requests.length, 0)
  } finally { dns.lookup = originalLookup; await context.close() }
})
