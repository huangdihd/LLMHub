/// <reference path="./semver.d.ts" />
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as requestHttp } from 'node:http'
import { request as requestHttps } from 'node:https'
import { Readable } from 'node:stream'
import { gt, satisfies, valid, validRange } from 'semver'
import { PLUGIN_API_VERSION } from '../core/plugin-version'
import { validateBaseUrl, type SSRFConfig } from '../utils/validate-url'
import { fetchWithRetry } from '../utils/fetch'
import type { PluginRecord } from '../../shared/types/plugin'

export const MARKET_README_LIMIT = 128 * 1024
const RESPONSE_LIMIT = 4 * 1024 * 1024
const SORTS = ['relevance', 'downloads', 'updated', 'name'] as const
export type MarketSort = typeof SORTS[number]
type Document = Record<string, unknown>

export class PluginMarketError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 502) {
    super(message)
    this.name = 'PluginMarketError'
  }
}

export interface MarketManager {
  getRegistry(): Promise<string>
  list(): PluginRecord[]
}

export interface MarketOptions {
  manager: MarketManager
  getSSRFConfig: () => Promise<SSRFConfig>
  timeoutMs?: number
  cacheTtlMs?: number
  /** Test seam for a local registry; production always uses DNS and address validation. */
  validateRegistry?: (url: URL, configuration: SSRFConfig) => Promise<void>
}

export interface MarketPackage {
  name: string
  version: string
  description?: string
  author?: string
  license?: string
  keywords: string[]
  date?: string
  links: { npm?: string; homepage?: string; repository?: string; bugs?: string }
  pluginId?: string
  displayName?: string
  publisher?: string
  score?: unknown
  metadataUnavailable?: boolean
  compatibilityReason?: string
  engines?: { llmhub: string }
  compatibility: 'compatible' | 'incompatible' | 'unknown'
  installed: boolean
  installedVersion?: string
  updateAvailable: boolean
}

export interface MarketSearchOptions {
  query?: string
  page?: number
  pageSize?: number
  sort?: MarketSort
}

function document(value: unknown): Document {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Document : {}
}

function text(value: unknown, limit = 4096): string | undefined {
  return typeof value === 'string' ? value.slice(0, limit) : undefined
}

/** Links are display-only. Never fetch URLs supplied by package metadata. */
export function safeMarketLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined
    return url.href
  } catch { return undefined }
}

function packageName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value)) {
    throw new PluginMarketError('INVALID_PACKAGE', 'Invalid npm package name', 400)
  }
  return value
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 6) {
    // Only global unicast; exclude transition/special-use ranges without blocking
    // ordinary public allocations such as 2001:4860::/32.
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
    const [first, second = '0'] = normalized.split(':')
    const secondWord = parseInt(second || '0', 16)
    return /^[23][0-9a-f]{3}:/i.test(normalized) && first !== '2002'
      && !(first === '2001' && (secondWord < 0x200 || secondWord === 0xdb8))
      && !(first === '3fff' && secondWord < 0x1000)
  }
  const [first = 0, second = 0, third = 0] = address.split('.').map(Number)
  return isIP(address) === 4 && first !== 0 && first !== 10 && first !== 127
    && !(first === 100 && second >= 64 && second <= 127)
    && !(first === 169 && second === 254) && !(first === 172 && second >= 16 && second <= 31)
    && !(first === 192 && (second === 168 || second === 0)) && !(first === 198 && (second === 18 || second === 19))
    && !(first === 198 && second === 51 && third === 100)
    && !(first === 203 && second === 0 && third === 113) && first < 224
}

async function validateRegistry(url: URL, configuration: SSRFConfig): Promise<void> {
  // Shared policy always blocks private literals; enabled controls only the host allowlist.
  // Extend that same boundary to DNS answers, including the actual socket lookup below.
  const validation = validateBaseUrl(url.href, configuration)
  if (!validation.valid) throw new PluginMarketError('REGISTRY_BLOCKED', 'Registry is blocked by outbound URL policy', 400)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  let addresses: { address: string }[]
  try { addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true }) }
  catch { throw new PluginMarketError('REGISTRY_UNAVAILABLE', 'Registry hostname could not be resolved') }
  if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) {
    throw new PluginMarketError('REGISTRY_BLOCKED', 'Registry resolves to a private or reserved address', 400)
  }
}

const markets = new WeakMap<MarketManager, PluginMarket>()

export function getPluginMarket(options: MarketOptions): PluginMarket {
  let market = markets.get(options.manager)
  if (!market) {
    market = new PluginMarket(options)
    markets.set(options.manager, market)
  }
  return market
}

export class PluginMarket {
  private readonly cache = new Map<string, { expires: number; value: Document }>()
  private generation = 0

  constructor(private readonly options: MarketOptions) {}

  clearCache(): { cleared: number } {
    const cleared = this.cache.size
    this.cache.clear()
    this.generation++
    return { cleared }
  }

  private async registry(): Promise<URL> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const resolveRegistry = async () => {
      const configuredRegistry = await this.options.manager.getRegistry()
      let url: URL
      try { url = new URL(configuredRegistry) }
      catch { throw new PluginMarketError('INVALID_REGISTRY', 'Configured npm registry is not a valid URL', 400) }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new PluginMarketError('INVALID_REGISTRY', 'Registry must be an HTTP(S) URL without credentials, query or fragment', 400)
      }
      if (!url.pathname.endsWith('/')) url.pathname += '/'
      const configuration = await this.options.getSSRFConfig()
      await (this.options.validateRegistry ?? validateRegistry)(url, configuration)
      return url
    }
    try {
      return await Promise.race([
        resolveRegistry(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new PluginMarketError('REGISTRY_TIMEOUT', 'Registry validation timed out', 504)), this.options.timeoutMs ?? 10_000)
        })
      ])
    } catch (error) {
      if (error instanceof PluginMarketError) throw error
      throw new PluginMarketError('REGISTRY_UNAVAILABLE', 'Registry configuration could not be loaded')
    } finally { clearTimeout(timer) }
  }

  /** Validate the actual connection lookup as well as the URL, preventing DNS rebinding. */
  private fetchRegistry(url: URL, signal?: AbortSignal | null): Promise<Response> {
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? requestHttps : requestHttp)(url, {
        headers: { accept: 'application/json' },
        signal: signal ?? undefined,
        lookup: (hostname, options, callback) => {
          lookup(hostname, { all: true }).then(addresses => {
            if (!addresses.length || (!this.options.validateRegistry && addresses.some(entry => !publicAddress(entry.address)))) {
              callback(new PluginMarketError('REGISTRY_BLOCKED', 'Registry resolves to a private or reserved address', 400), '', 4)
              return
            }
            // Hand the checked addresses directly to the socket; never resolve a second time.
            if (options.all) callback(null, addresses)
            else callback(null, addresses[0]!.address, addresses[0]!.family)
          }, error => callback(error, '', 4))
        }
      }, response => {
        const status = response.statusCode ?? 502
        if ([204, 205, 304].includes(status)) {
          response.destroy()
          resolve(new Response(null, { status }))
          return
        }
        resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status }))
      })
      request.once('error', reject)
      request.end()
    })
  }

  private async request(url: URL, search = false, validate: (value: Document) => void = () => {}, generation = this.generation): Promise<Document> {
    const key = url.href
    const cached = this.cache.get(key)
    if (cached && cached.expires > Date.now()) {
      validate(cached.value)
      return cached.value
    }
    const timeout = this.options.timeoutMs ?? 10_000
    let timer: ReturnType<typeof setTimeout> | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let expired = false
    const operation = async () => {
      const response = await fetchWithRetry(url.href, {
        timeout,
        // Market reads have one overall deadline, including the bounded response body.
        // Preserve explicit upstream errors rather than retrying within that deadline.
        maxRetries: 0,
        redirect: 'manual',
        transport: (address, options) => this.fetchRegistry(new URL(address), options.signal)
      })
      if (expired) { await response.body?.cancel(); throw new Error('Expired request') }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        throw new PluginMarketError('REGISTRY_UNAVAILABLE', 'Registry redirects are not allowed')
      }
      if (!response.ok) {
        await response.body?.cancel()
        if (search && [404, 405, 501].includes(response.status)) {
          throw new PluginMarketError('SEARCH_UNSUPPORTED', 'This registry does not support npm search', 501)
        }
        if (response.status === 404) throw new PluginMarketError('PACKAGE_NOT_FOUND', 'Package was not found in this registry', 404)
        throw new PluginMarketError('REGISTRY_ERROR', `Registry returned HTTP ${response.status}`)
      }
      if (!response.body) throw new PluginMarketError('INVALID_RESPONSE', 'Registry returned an empty response')
      reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.byteLength
        if (length > RESPONSE_LIMIT) throw new PluginMarketError('RESPONSE_TOO_LARGE', 'Registry response exceeds the 4 MiB limit')
        chunks.push(chunk.value)
      }
      let value: unknown
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { throw new PluginMarketError('INVALID_RESPONSE', 'Registry returned invalid JSON') }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginMarketError('INVALID_RESPONSE', 'Registry returned invalid metadata')
      validate(value as Document)
      if (!expired && generation === this.generation) {
        if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!)
        this.cache.set(key, { expires: Date.now() + (this.options.cacheTtlMs ?? 60_000), value: value as Document })
      }
      return value as Document
    }
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true
          void reader?.cancel().catch(() => {})
          reject(new PluginMarketError('REGISTRY_TIMEOUT', 'Registry request timed out', 504))
        }, timeout)
      })])
    } catch (error) {
      if (error instanceof PluginMarketError) throw error
      if (error instanceof Error && error.name === 'AbortError') throw new PluginMarketError('REGISTRY_TIMEOUT', 'Registry request timed out', 504)
      throw new PluginMarketError('REGISTRY_UNAVAILABLE', 'Registry request failed')
    } finally {
      clearTimeout(timer)
      await reader?.cancel().catch(() => {})
    }
  }

  private summarize(metadata: Document, records: PluginRecord[]): MarketPackage {
    const name = packageName(metadata.name)
    const version = text(metadata.version, 256) ?? ''
    const derivedId = name.replace(/^@[^/]+\//, '').replace(/^llmhub-plugin-/, '')
    const pluginId = text(document(metadata.llmhub).id, 214) ?? (/^[a-z0-9][a-z0-9-]{1,40}$/.test(derivedId) ? derivedId : undefined)
    // npm package identity takes precedence; plugin IDs alone are not proof of package ownership.
    const installed = records.find(record => {
      const source = document((record as unknown as Document).source)
      return source.packageName === name || source.name === name || (record as unknown as Document).packageName === name
    })
    const declaredRange = document(metadata.engines).llmhub
    const range = text(declaredRange, 256)
    let compatibility: MarketPackage['compatibility'] = 'unknown'
    // Truncation is for display only: it can turn an invalid/restrictive range into '*'.
    if (typeof declaredRange === 'string' && declaredRange.trim() && validRange(declaredRange)) {
      compatibility = satisfies(PLUGIN_API_VERSION, declaredRange) ? 'compatible' : 'incompatible'
    }
    const links = document(metadata.links)
    const repository = document(metadata.repository)
    const bugs = document(metadata.bugs)
    return {
      name, version, description: text(metadata.description),
      displayName: text(document(metadata.llmhub).name) ?? name,
      publisher: text(document(metadata.publisher).username ?? document(metadata._npmUser).name),
      score: metadata.score,
      compatibilityReason: compatibility === 'incompatible' ? `Requires plugin API ${range}; current version is ${PLUGIN_API_VERSION}` : undefined,
      author: text(typeof metadata.author === 'string' ? metadata.author : document(metadata.author).name, 256),
      license: text(metadata.license, 256),
      keywords: Array.isArray(metadata.keywords) ? metadata.keywords.filter((item): item is string => typeof item === 'string').slice(0, 100).map(item => item.slice(0, 128)) : [],
      date: text(metadata.date, 128),
      links: {
        npm: safeMarketLink(links.npm), homepage: safeMarketLink(metadata.homepage ?? links.homepage),
        repository: safeMarketLink(repository.url ?? metadata.repository ?? links.repository),
        bugs: safeMarketLink(bugs.url ?? metadata.bugs ?? links.bugs)
      },
      pluginId, engines: range ? { llmhub: range } : undefined,
      compatibility,
      installed: !!installed, installedVersion: installed?.manifest.version,
      updateAvailable: !!installed && !!valid(version) && !!valid(installed.manifest.version) && gt(version, installed.manifest.version)
    }
  }

  async search(options: MarketSearchOptions = {}) {
    const { query = '', page = 1, pageSize = 20, sort = 'relevance' } = options
    if (typeof query !== 'string' || query.length > 200 || !Number.isInteger(page) || page < 1 || page > 1000
      || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !SORTS.includes(sort)) {
      throw new PluginMarketError('INVALID_SEARCH', 'Invalid market query, page, pageSize or sort', 400)
    }
    // Keep the whole search, including delayed enrichment, in one cache generation.
    const generation = this.generation
    const registry = await this.registry()
    const url = new URL('-/v1/search', registry)
    url.searchParams.set('text', `${query.trim()} keywords:llmhub-plugin`.trim())
    url.searchParams.set('from', String((page - 1) * pageSize))
    url.searchParams.set('size', String(pageSize))
    // npm's standard endpoint supports ranking weights, not arbitrary server-side sort keys.
    if (sort === 'downloads') { url.searchParams.set('popularity', '1'); url.searchParams.set('quality', '0'); url.searchParams.set('maintenance', '0') }
    const result = await this.request(url, true, value => {
      if (!Array.isArray(value.objects) || typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < 0) {
        throw new PluginMarketError('INVALID_RESPONSE', 'Registry returned invalid npm search results')
      }
      for (const item of value.objects) {
        try { packageName(document(document(item).package).name) }
        catch { throw new PluginMarketError('INVALID_RESPONSE', 'Registry returned an invalid package name') }
      }
    }, generation)
    const records = this.options.manager.list()
    const items = await Promise.all((result.objects as unknown[]).slice(0, pageSize).map(async item => {
      const searchEntry = document(item)
      const summary = document(searchEntry.package)
      // Standard search results omit custom metadata and engines; enrich from packuments.
      let metadata: Document = {}
      let metadataUnavailable = false
      if (!summary.engines || !summary.llmhub) {
        try {
          metadata = await this.request(new URL(encodeURIComponent(packageName(summary.name)), registry), false, value => {
            if (value.name !== summary.name) throw new PluginMarketError('INVALID_RESPONSE', 'Registry returned a different package')
            const release = document(document(value.versions)[String(summary.version)])
            if (typeof summary.version !== 'string' || !valid(summary.version) || release.version !== summary.version) {
              throw new PluginMarketError('INVALID_RESPONSE', 'Registry package is missing the searched release')
            }
          }, generation)
        } catch (error) {
          // Optional enrichment must not turn a working search into a total outage.
          if (!(error instanceof PluginMarketError) || error.code === 'REGISTRY_BLOCKED') throw error
          metadataUnavailable = true
        }
      }
      const release = document(document(metadata.versions)[String(summary.version)])
      return { ...this.summarize({ ...summary, ...release, name: summary.name, version: summary.version, score: searchEntry.score }, records), metadataUnavailable }
    }))
    if (sort === 'updated') items.sort((left, right) => (right.date ?? '').localeCompare(left.date ?? ''))
    if (sort === 'name') items.sort((left, right) => left.name.localeCompare(right.name))
    return { items, total: result.total, page, pageSize, sort, sortScope: sort === 'updated' || sort === 'name' ? 'page' : 'registry', registry: registry.href, apiVersion: PLUGIN_API_VERSION }
  }

  async detail(name: string) {
    packageName(name)
    const generation = this.generation
    const registry = await this.registry()
    const metadata = await this.request(new URL(encodeURIComponent(name), registry), false, value => {
      if (value.name !== name) throw new PluginMarketError('INVALID_RESPONSE', 'Registry returned a different package')
      const latest = text(document(value['dist-tags']).latest, 256)
      const release = document(latest ? document(value.versions)[latest] : undefined)
      if (!latest || !valid(latest) || release.version !== latest) throw new PluginMarketError('INVALID_RESPONSE', 'Registry package has no valid latest release')
    }, generation)
    const latest = text(document(metadata['dist-tags']).latest, 256)
    const versions = document(metadata.versions)
    const release = document(versions[latest!])
    const readme = typeof metadata.readme === 'string' ? metadata.readme : typeof release.readme === 'string' ? release.readme : ''
    const readmeBytes = Buffer.from(readme, 'utf8')
    // Return text, never rendered HTML; callers must render Markdown with raw HTML disabled.
    const boundedReadme = new TextDecoder('utf-8', { fatal: false }).decode(readmeBytes.subarray(0, MARKET_README_LIMIT), { stream: true })
    return {
      ...this.summarize({ ...release, name, date: document(metadata.time)[latest!] }, this.options.manager.list()),
      readme: boundedReadme, readmeTruncated: readmeBytes.length > MARKET_README_LIMIT,
      versions: Object.keys(versions).filter(version => valid(version)).slice(0, 1000),
      releases: Object.entries(versions).filter(([version]) => valid(version)).slice(0, 1000).map(([version, value]) => {
        const release = document(value)
        const plugin = document(release.llmhub)
        const records = this.options.manager.list()
        const dependencies = document(plugin.dependencies)
        const optionalDependencies = document(plugin.optionalDependencies)
        return { version, engines: release.engines, dependencies: release.dependencies ?? {}, peerDependencies: release.peerDependencies ?? {},
          pluginDependencies: dependencies, optionalPluginDependencies: optionalDependencies,
          dependencyStatus: Object.entries({ ...optionalDependencies, ...dependencies }).map(([id, range]) => {
            const installed = records.find(record => record.id === id)
            const satisfied = !!installed && installed.enabled && installed.status !== 'error' && typeof range === 'string' && !!validRange(range) && !!valid(installed.manifest.version) && satisfies(installed.manifest.version, range)
            return { id, range, optional: !Object.hasOwn(dependencies, id), builtin: installed?.builtin ?? false, version: installed?.manifest.version, satisfied,
              reason: satisfied ? undefined : installed ? 'Installed dependency is disabled, failed or outside the requested range' : 'Dependency is not installed' }
          }) }
      }),
      registry: registry.href, apiVersion: PLUGIN_API_VERSION
    }
  }
}
