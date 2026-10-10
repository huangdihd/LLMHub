import { mkdir, readdir, readFile, writeFile, rename, rm, lstat, mkdtemp, realpath } from 'node:fs/promises'
import { resolve, dirname, basename, relative, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { gt, valid } from 'semver'
import { packageCapabilities, packageUpdates, type PackageExecutor } from './package-operations'
import { discoverPackages, installProject, runNpm, type NpmRunner } from './npm-project'
import { DEFAULT_REGISTRY, githubSpecification, npmSpecification, validateRegistry, type PackageSpecification } from './specifications'
import { createModuleGeneration, GENERATIONS_DIRECTORY, type ModuleGeneration } from './module-generation'
import { assertCompatibility, decorateRecords, dependencyIssues, dependencyOrder, manifestWarnings } from './dependencies'
import type { H3Event } from 'h3'
import type { ProviderDefinition, ProviderRegistry } from '../core/registry'
import type { RequestHook, HookRegistry } from '../core/hooks'
import { ProtocolRegistry, type ProtocolDefinition } from '../core/protocol-registry'
import { IngressRegistry, type IngressDefinition } from '../core/ingress-registry'
import { recordValuesKey, withRecordValuesLock, type StoredRecordValues } from './record-values'
import type { PluginRecordLocation, PluginRecordValues, PluginRecordValuesChange, PluginMetricGetter, PluginMetricResult, PluginContributionRecord, PluginManifest, PluginRecord, PluginSource } from '../../shared/types/plugin'
import { PluginError, safePath, validatePath, validateId, validateManifest, validatePackageManifest, normalizeManifest, validateFields, validateConfiguration } from './manifest'

export interface PluginStorage {
  getItem<T>(key: string): Promise<T | null>
  setItem<T>(key: string, value: T): Promise<unknown>
  removeItem(key: string): Promise<unknown>
  getKeys?(prefix: string): Promise<string[]>
}
type Cleanup = () => void | Promise<void>
type RouteHandler = (event: H3Event) => unknown | Promise<unknown>
export interface PluginAPI {
  getRecordValues(location: PluginRecordLocation, recordId: string): Promise<PluginRecordValues>
  getAllRecordValues(location: PluginRecordLocation): Promise<Record<string, PluginRecordValues>>
  onRecordValuesChange(listener: (change: PluginRecordValuesChange) => void | Promise<void>): void
  registerMetric(key: string, getter: PluginMetricGetter): void
  readonly config: Readonly<Record<string, unknown>>
  provide(value: object): void
  require<T extends object = Record<string, unknown>>(pluginId: string): T | undefined
  registerProvider(definition: ProviderDefinition): void
  registerProtocol(definition: ProtocolDefinition): void
  registerIngress(definition: IngressDefinition): void
  registerHook(hook: RequestHook): void
  registerRoute(method: string, path: string, handler: RouteHandler): void
  onConfigChange(listener: (configuration: Readonly<Record<string, unknown>>) => void | Promise<void>): void
  storage: PluginStorage
  logger: Pick<Console, 'info' | 'warn' | 'error'>
}
export interface PluginModule {
  default?: { setup(api: PluginAPI): void | Cleanup | Promise<void | Cleanup> }
  setup?: (api: PluginAPI) => void | Cleanup | Promise<void | Cleanup>
}
interface InstalledPlugin {
  manifest: PluginManifest
  directory: string
  entry: string
  configuration: Record<string, unknown>
  enabled: boolean
  error?: string
  installed?: boolean
  invalid?: boolean
  runtime?: Runtime
  source?: PluginSource
  isolateModules?: boolean
}
interface Runtime {
  recordListeners: Array<(change: PluginRecordValuesChange) => void | Promise<void>>
  metrics: Map<string, PluginMetricGetter>
  moduleGeneration?: ModuleGeneration
  exports?: object
  accepting: boolean
  active: boolean
  unregister: Cleanup[]
  cleanup?: Cleanup
  providers: string[]
  protocols: string[]
  ingresses: string[]
  hooks: string[]
  routes: Map<string, RouteHandler>
  listeners: Array<(configuration: Readonly<Record<string, unknown>>) => void | Promise<void>>
}
export interface PluginManagerOptions {
  listRecordIds?: (location: PluginRecordLocation) => Promise<string[]>
  requireBuiltin?: (id: string) => object | undefined
  builtinPlugins?: () => PluginRecord[]
  dispatchBuiltinRoute?: (id: string, method: string, path: string, event: H3Event) => unknown | Promise<unknown>
  directory?: string
  rootDirectory?: string
  storage: PluginStorage
  providerRegistry: ProviderRegistry
  hookRegistry: HookRegistry
  protocolRegistry?: ProtocolRegistry
  ingressRegistry?: IngressRegistry
  npmRunner?: NpmRunner
  packageExecutor?: PackageExecutor
  timeoutMs?: number
  cleanupTimeoutMs?: number
  onRegistryChange?: () => void
}
const importModule = new Function('url', 'return import(url)') as (url: string) => Promise<PluginModule>

export class PluginManager {
  private readonly options: PluginManagerOptions
  private readonly protocolRegistry: ProtocolRegistry
  private readonly ingressRegistry: IngressRegistry
  private readonly directory: string
  private readonly plugins = new Map<string, InstalledPlugin>()
  private queue: Promise<unknown> = Promise.resolve()
  private storageRollback?: Map<string, unknown>

  constructor(options: PluginManagerOptions) {
    this.options = options
    this.protocolRegistry = options.protocolRegistry ?? new ProtocolRegistry()
    this.ingressRegistry = options.ingressRegistry ?? new IngressRegistry()
    this.directory = resolve(options.directory ?? options.rootDirectory ?? '.data/plugins')
  }

  private async bounded<T>(operation: Promise<T>, cleanup = false): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PluginError('Plugin operation timed out')), cleanup ? this.options.cleanupTimeoutMs ?? 1000 : this.options.timeoutMs ?? 5000)
      })])
    } finally { clearTimeout(timer) }
  }

  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queue
    const next = previous.catch(() => {}).then(operation).catch(error => {
      if (error instanceof PluginError) throw error
      // Plugin-thrown errors may carry secrets: log them server-side, never return them.
      console.error(`[LLMHub] Runtime plugin operation failed (${id}):`, error)
      throw new PluginError('Plugin operation failed')
    })
    this.queue = next.catch(() => {})
    return next
  }

  private get(id: string): InstalledPlugin {
    validateId(id)
    this.assertRuntimePlugin(id)
    const plugin = this.plugins.get(id)
    if (!plugin) throw new PluginError('Plugin not found')
    return plugin
  }

  private assertRuntimePlugin(id: string): void {
    if (this.options.builtinPlugins?.().some(plugin => plugin.id === id)) throw new PluginError('Built-in plugins are read-only')
  }

  list(): PluginRecord[] {
    const runtimePlugins: PluginRecord[] = [...this.plugins.values()].map(plugin => ({ id: plugin.manifest.id, manifest: structuredClone(plugin.manifest),
      source: plugin.source ?? { type: 'directory' }, capabilities: { update: !!plugin.source?.direct, uninstall: !plugin.source || !['npm', 'github'].includes(plugin.source.type) || !!plugin.source.direct }, warnings: manifestWarnings(plugin.manifest), enabled: plugin.enabled, status: plugin.error ? 'error' : plugin.enabled ? 'enabled' : plugin.installed ? 'installed' : 'disabled', error: plugin.error,
      providers: [...(plugin.runtime?.providers ?? [])], hooks: [...(plugin.runtime?.hooks ?? [])],
      protocols: [...(plugin.runtime?.protocols ?? [])], ingresses: [...(plugin.runtime?.ingresses ?? [])] }))
    return decorateRecords([...(this.options.builtinPlugins?.() ?? []).map(plugin => ({ ...plugin, source: { type: 'builtin' as const } })), ...runtimePlugins])
  }

  async getRegistry(): Promise<string> {
    return validateRegistry(await this.options.storage.getItem<string>('runtime-plugins:registry') ?? DEFAULT_REGISTRY)
  }

  async listSources(): Promise<Record<string, PackageSpecification>> {
    return structuredClone((await this.npmState()).sources)
  }

  capabilities() {
    return packageCapabilities(this.options.packageExecutor)
  }

  updates(id: string) {
    return this.serial(id, async () => {
      const plugin = this.get(id)
      const source = plugin.source
      if (!source?.direct || !source.packageName) throw new PluginError('Only directly installed packages can be updated')
      const saved = (await this.npmState()).sources[source.packageName]
      if (!saved) throw new PluginError('Package installation source is unavailable')
      return packageUpdates({ ...saved, commit: source.commit }, await this.getRegistry(), plugin.manifest.version, this.options.packageExecutor)
    })
  }

  setRegistry(registry: unknown): Promise<string> {
    return this.serial('$registry', async () => {
      const normalized = validateRegistry(registry)
      await this.options.storage.setItem('runtime-plugins:registry', normalized)
      return normalized
    })
  }

  private async readDirectoryManifest(directory: string): Promise<PluginManifest> {
    try {
      const metadata = JSON.parse(await readFile(await safePath(directory, 'package.json'), 'utf8'))
      const manifest = validatePackageManifest(metadata)
      // Directory packages use the same dependency graph as npm-installed packages.
      // Resolve from the importing package, not from a global package-name map.
      const required = { ...metadata.peerDependencies, ...metadata.dependencies }
      const optional = { ...metadata.optionalDependencies }
      for (const [name, range] of Object.entries(metadata.peerDependencies ?? {})) {
        if (metadata.peerDependenciesMeta?.[name]?.optional !== true || Object.hasOwn(metadata.dependencies ?? {}, name)) continue
        optional[name] ??= range
        delete required[name]
      }
      for (const name of Object.keys(optional)) delete required[name]
      for (const [dependencies, key] of [[required, 'dependencies'], [optional, 'optionalDependencies']] as const) {
        for (const [name, range] of Object.entries(dependencies)) {
          // A package name is a path component here, never an installation spec.
          if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new PluginError('Invalid npm dependency name')
          for (let ancestor = directory; ; ancestor = dirname(ancestor)) {
            try {
              const dependency = JSON.parse(await readFile(await safePath(ancestor, `node_modules/${name}/package.json`), 'utf8'))
              if (Object.hasOwn(dependency, 'llmhub')) {
                const dependencyManifest = validatePackageManifest(dependency)
                manifest[key] = { ...manifest[key], [dependencyManifest.id]: manifest[key]?.[dependencyManifest.id] ?? range as string }
              }
              break
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
            if (ancestor === dirname(ancestor)) break
          }
        }
      }
      return manifest
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return validateManifest(JSON.parse(await readFile(await safePath(directory, 'plugin.json'), 'utf8')))
  }

  private async npmState(): Promise<{ directory: string; sources: Record<string, PackageSpecification> }> {
    const state = await this.options.storage.getItem<{ directory: string; sources: Record<string, PackageSpecification> }>('runtime-plugins:npm-project')
    return { directory: this.directory, sources: state?.sources ?? {} }
  }

  private async discoverNpmPlugins(activate: Set<string>): Promise<void> {
    const state = await this.npmState()
    for (const discovered of await discoverPackages(state.directory, true)) {
      this.assertRuntimePlugin(discovered.manifest.id)
      const existing = this.plugins.get(discovered.manifest.id)
      if (existing) {
        if (existing.source?.packageName !== discovered.packageName) throw new PluginError('Plugin identity collision')
        continue
      }
      const stored = await this.options.storage.getItem<{ enabled?: boolean; configuration?: Record<string, unknown>; source?: InstalledPlugin['source'] }>(`runtime-plugins:${discovered.manifest.id}:state`)
      if (!discovered.invalid) {
        try { assertCompatibility(discovered.manifest) }
        catch (error) {
          discovered.error = error instanceof PluginError ? error.message : 'Plugin compatibility check failed'
        }
      }
      const source = state.sources[discovered.packageName]
      this.plugins.set(discovered.manifest.id, { ...discovered, entry: discovered.manifest.entry!, enabled: false, isolateModules: true,
        configuration: validateConfiguration(discovered.manifest.configSchema ?? [], stored?.configuration ?? {}, {}, false),
        source: { ...source, type: source?.source ?? 'npm', packageName: discovered.packageName, direct: !!source } })
      if (stored?.enabled && !discovered.invalid) activate.add(discovered.manifest.id)
    }
  }

  installNpm(specification: unknown, force = false): Promise<PluginRecord[]> {
    return this.serial('$npm-install', () => this.installPackage(npmSpecification(specification), force))
  }

  installGithub(specification: unknown, force = false): Promise<PluginRecord[]> {
    return this.serial('$github-install', () => this.installPackage(githubSpecification(specification), force))
  }

  update(id: string, specification?: unknown, force = false): Promise<PluginRecord[]> {
    return this.serial(id, async () => {
      const source = this.get(id).source
      if (!source?.direct || !source.specification) throw new PluginError('Only directly installed packages can be updated')
      const saved = (await this.npmState()).sources[source.packageName!]
      const parsed = source.type === 'github' ? githubSpecification(specification ?? saved) : npmSpecification(specification ?? { name: source.packageName, version: saved?.range })
      if (parsed.packageName && parsed.packageName !== source.packageName) throw new PluginError('Package update cannot change package identity')
      return this.installPackage(parsed, force, source.packageName)
    })
  }

  private async installPackage(specification: PackageSpecification, force: boolean, previousName?: string): Promise<PluginRecord[]> {
    if (specification.source === 'github') {
      const capabilities = await this.capabilities()
      if (!capabilities.git.available) throw new PluginError(`GitHub installation unavailable: git ${capabilities.git.reason}`)
    }
    await this.prepareDirectory()
    const state = await this.npmState()
    const sources = { ...state.sources }
    // GitHub's package name is metadata, never guessed from the repository name.
    let packageName = specification.packageName ?? previousName
    let probe: string | undefined
    try {
      if (!packageName) {
        probe = await mkdtemp(join(await realpath(tmpdir()), 'llmhub-npm-probe-'))
        await installProject(probe, { 'llmhub-github-probe': specification.specification }, await this.getRegistry(), this.options.npmRunner ?? runNpm)
        const metadata = JSON.parse(await readFile(await safePath(probe, 'node_modules/llmhub-github-probe/package.json'), 'utf8'))
        const manifest = normalizeManifest(metadata, true)
        this.assertRuntimePlugin(manifest.id)
        packageName = metadata.name
      }
      sources[packageName!] = specification
      return await this.replaceNpmProject(sources, force, packageName)
    } finally { if (probe) await rm(probe, { recursive: true, force: true }) }
  }

  private async uninstallPackage(id: string): Promise<PluginRecord[]> {
    const plugin = this.get(id)
    if (!plugin.source?.direct || !plugin.source.packageName) throw new PluginError('Transitive packages must be removed through their owning package')
    this.assertRemovable(id)
    const state = await this.npmState()
    const sources = { ...state.sources }
    delete sources[plugin.source.packageName]
    return this.replaceNpmProject(sources, false)
  }

  private async replaceNpmProject(sources: Record<string, PackageSpecification>, force: boolean, updatingPackage?: string): Promise<PluginRecord[]> {
    const previousState = await this.options.storage.getItem('runtime-plugins:npm-project')
    const temporary = await mkdtemp(join(await realpath(tmpdir()), 'llmhub-npm-transaction-'))
    const directory = resolve(temporary, 'project')
    const backup = resolve(temporary, 'backup')
    const previous = new Map(this.plugins)
    // Every npm runtime shares the replaced library tree. Only its enabled dependents
    // outside that tree need restarting; unrelated directory plugins stay live.
    const affected = new Set<string>()
    for (const plugin of previous.values()) {
      if (!plugin.source || !['npm', 'github'].includes(plugin.source.type)) continue
      for (const dependent of this.affected(plugin.manifest.id)) affected.add(dependent.manifest.id)
    }
    const enabled = new Set([...previous.values()].filter(plugin => plugin.enabled && affected.has(plugin.manifest.id)).map(plugin => plugin.manifest.id))
    const backedUp: string[] = []
    const activated: string[] = []
    let stopped = false
    let rollbackFailed = false
    try {
      const dependencies = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, source.source === 'npm' ? source.range ?? '*' : source.specification]))
      await mkdir(directory, { recursive: true })
      try {
        const lock = JSON.parse(await readFile(await safePath(this.directory, 'package-lock.json'), 'utf8'))
        // Refresh only the requested direct package; unrelated locked versions stay pinned.
        if (updatingPackage) {
          delete lock.packages?.[`node_modules/${updatingPackage}`]
          delete lock.dependencies?.[updatingPackage]
        }
        await writeFile(resolve(directory, 'package-lock.json'), JSON.stringify(lock))
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await installProject(directory, dependencies, await this.getRegistry(), this.options.npmRunner ?? runNpm)
      const discovered = await discoverPackages(directory, true)
      let lock: { packages?: Record<string, { resolved?: string }> } = {}
      try { lock = JSON.parse(await readFile(resolve(directory, 'package-lock.json'), 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      for (const [name, source] of Object.entries(sources)) {
        if (source.source !== 'github') continue
        const resolved = lock.packages?.[`node_modules/${name}`]?.resolved
        const commit = resolved?.match(/#([a-f0-9]{40}|[a-f0-9]{64})$/)?.[1]
        if (!commit) throw new PluginError('GitHub installation did not resolve to a commit in package-lock.json')
        sources[name] = { ...source, packageName: name, commit } as PackageSpecification
      }
      for (const name of Object.keys(sources)) if (!discovered.some(plugin => plugin.packageName === name)) throw new PluginError('Installed package does not expose llmhub plugin metadata')
      const replacements = new Map([...previous].filter(([, plugin]) => !plugin.source || !['npm', 'github'].includes(plugin.source.type)))
      for (const candidate of discovered) {
        const id = candidate.manifest.id
        this.assertRuntimePlugin(id)
        if (replacements.has(id)) throw new PluginError('Plugin identity collision')
        const old = previous.get(id)
        const previousPackage = [...previous.values()].find(plugin => plugin.source?.packageName === candidate.packageName)
        if (previousPackage && previousPackage.manifest.id !== id) throw new PluginError('Package update cannot change plugin identity')
        if (old && old.source?.packageName !== candidate.packageName) throw new PluginError('Plugin identity collision')
        if (old) {
          if (candidate.invalid) throw new PluginError(candidate.error ?? 'Invalid plugin replacement')
          this.assertVersion(old.manifest, candidate.manifest, force)
        } else {
          try { assertCompatibility(candidate.manifest) }
          catch (error) {
            candidate.invalid = true
            candidate.error = error instanceof PluginError ? error.message : 'Plugin compatibility check failed'
          }
        }
        const source = sources[candidate.packageName]
        replacements.set(id, { ...candidate, directory: resolve(this.directory, relative(directory, candidate.directory)), entry: candidate.manifest.entry!, isolateModules: true, enabled: false, installed: !old,
          configuration: validateConfiguration(candidate.manifest.configSchema ?? [], old?.configuration ?? {}, {}, false),
          source: { ...source, type: source?.source ?? 'npm', packageName: candidate.packageName, direct: !!source } })
      }
      const { cycles } = dependencyOrder([...replacements.values()].map(plugin => plugin.manifest))
      if (cycles.size) throw new PluginError([...cycles.values()][0])
      // Refuse removing a transitive package still required by a live local consumer.
      for (const plugin of replacements.values()) {
        if (!enabled.has(plugin.manifest.id)) continue
        for (const dependency of Object.keys(plugin.manifest.dependencies ?? {})) {
          if (previous.has(dependency) && !replacements.has(dependency)) throw new PluginError(`Plugin ${dependency} is required by enabled plugin ${plugin.manifest.id}`)
        }
      }
      stopped = true
      for (const plugin of [...this.ordered(enabled)].reverse()) await this.stop(plugin)
      await mkdir(backup)
      for (const name of ['package.json', 'package-lock.json', 'node_modules']) {
        try { await rename(resolve(this.directory, name), resolve(backup, name)); backedUp.push(name) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        try { await rename(resolve(directory, name), resolve(this.directory, name)); activated.push(name) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      this.plugins.clear()
      for (const [id, plugin] of replacements) this.plugins.set(id, plugin)
      this.storageRollback = new Map()
      // Disabled packages are never executed: they are validated when next enabled.
      for (const plugin of this.ordered(enabled)) await this.start(plugin)
      for (const id of enabled) {
        const plugin = this.plugins.get(id)
        if (plugin && dependencyIssues(plugin.manifest, this.list()).length) throw new PluginError('npm operation would disable a required plugin dependency')
      }
      for (const [id, plugin] of replacements) {
        if (!plugin.source || !['npm', 'github'].includes(plugin.source.type)) continue
        const key = `runtime-plugins:${id}:state`
        this.storageRollback.set(key, await this.options.storage.getItem(key))
        await this.persist(plugin)
      }
      for (const id of previous.keys()) {
        if (replacements.has(id)) continue
        const keys = await this.options.storage.getKeys?.(`runtime-plugins:${id}:storage:`) ?? []
        for (const key of [...keys, recordValuesKey(id), `runtime-plugins:${id}:state`, `runtime-plugins:${id}:source`]) {
          this.storageRollback.set(key, await this.options.storage.getItem(key))
          await this.options.storage.removeItem(key)
        }
      }
      await this.options.storage.setItem('runtime-plugins:npm-project', { directory: this.directory, sources })
      return this.list()
    } catch (error) {
      if (!stopped) throw error
      for (const plugin of [...this.ordered(enabled)].reverse()) {
        try { await this.stop(plugin) } catch { rollbackFailed = true }
      }
      for (const name of activated) {
        try { await rm(resolve(this.directory, name), { recursive: true, force: true }) } catch { rollbackFailed = true }
      }
      for (const name of backedUp) {
        try { await rename(resolve(backup, name), resolve(this.directory, name)) } catch { rollbackFailed = true }
      }
      const storageRollback = this.storageRollback
      this.storageRollback = undefined
      for (const [key, value] of storageRollback ?? []) {
        try { if (value === null) await this.options.storage.removeItem(key); else await this.options.storage.setItem(key, value) }
        catch { rollbackFailed = true }
      }
      try {
        if (previousState === null) await this.options.storage.removeItem('runtime-plugins:npm-project')
        else await this.options.storage.setItem('runtime-plugins:npm-project', previousState)
      } catch { rollbackFailed = true }
      this.plugins.clear()
      for (const [id, plugin] of previous) this.plugins.set(id, plugin)
      for (const plugin of this.ordered(enabled)) {
        try { await this.start(plugin) } catch { rollbackFailed = true }
      }
      if (rollbackFailed) throw new PluginError(`npm rollback incomplete; recovery files retained at ${backup}`)
      throw error
    } finally {
      this.storageRollback = undefined
      if (!rollbackFailed) await rm(temporary, { recursive: true, force: true })
    }
  }

  private generationsSwept = false

  private async prepareDirectory(): Promise<void> {
    // Validate the existing ancestor before recursive mkdir can follow a symlink.
    let ancestor = this.directory
    for (;;) {
      try { await lstat(ancestor); break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        ancestor = dirname(ancestor)
      }
    }
    await safePath(ancestor)
    await mkdir(this.directory, { recursive: true })
    await safePath(this.directory)
    if (!this.generationsSwept) {
      // Snapshots left behind by a crashed process are never reused.
      this.generationsSwept = true
      await rm(resolve(this.directory, GENERATIONS_DIRECTORY), { recursive: true, force: true })
    }
  }

  private async validateEntry(directory: string, entry: string): Promise<string> {
    const filename = await safePath(directory, entry)
    if (!/\.(?:mjs|cjs|js)$/.test(filename) || !(await lstat(filename)).isFile()) throw new PluginError('Invalid plugin entry')
    return filename
  }

  private async loadModule(directory: string, entry: string, runtime?: Runtime): Promise<PluginModule> {
    const filename = await this.validateEntry(directory, entry)
    if (!runtime) return this.bounded(importModule(`${pathToFileURL(filename).href}?generation=${randomUUID()}`))
    const generation = await createModuleGeneration(directory, this.directory)
    runtime.moduleGeneration = generation
    if (!runtime.active) {
      await generation.dispose()
      throw new PluginError('Plugin registration is closed')
    }
    // start owns the timeout and disposes the snapshot again after late completion.
    return importModule(pathToFileURL(await safePath(generation.directory, entry)).href)
  }

  private assertVersion(previous: PluginManifest, next: PluginManifest, force = false): void {
    assertCompatibility(next)
    if (previous.version !== next.version && !valid(next.version)) throw new PluginError('Plugin upgrade version must be valid semver')
    if (!force && valid(previous.version) && valid(next.version) && gt(previous.version, next.version)) {
      throw new PluginError('Plugin downgrade requires force')
    }
  }

  private ordered(ids: Iterable<string>): InstalledPlugin[] {
    const selected = new Set(ids)
    const { order } = dependencyOrder([...this.plugins.values()].map(plugin => plugin.manifest))
    return [...new Set([...order, ...selected])].filter(id => selected.has(id) && this.plugins.has(id)).map(id => this.get(id))
  }

  private affected(id: string): InstalledPlugin[] {
    const ids = new Set([id])
    for (;;) {
      const size = ids.size
      for (const plugin of this.plugins.values()) {
        if (!plugin.enabled) continue
        const dependencies = { ...plugin.manifest.dependencies, ...plugin.manifest.optionalDependencies }
        if (Object.keys(dependencies).some(dependency => ids.has(dependency))) ids.add(plugin.manifest.id)
      }
      if (ids.size === size) return this.ordered(ids)
    }
  }

  private assertRemovable(id: string): void {
    const dependents = [...this.plugins.values()].filter(plugin => plugin.enabled && Object.hasOwn(plugin.manifest.dependencies ?? {}, id))
    if (dependents.length) throw new PluginError(`Plugin is required by enabled plugins: ${dependents.map(plugin => plugin.manifest.id).join(', ')}`)
  }

  async scan(): Promise<PluginRecord[]> {
    return this.serial('$scan', async () => {
      await this.prepareDirectory()
      const activate = new Set<string>()
      try { await this.discoverNpmPlugins(activate) }
      catch (error) { console.warn('[LLMHub] Failed to discover npm plugins:', error) }
      const changed: string[] = []
      // Discover every manifest before activating anything: filesystem order is not dependency order.
      for (const item of await readdir(this.directory, { withFileTypes: true })) {
        if (!item.isDirectory() || item.name.startsWith('.') || item.name === 'node_modules') continue
        try {
          validateId(item.name)
          if (this.options.builtinPlugins?.().some(plugin => plugin.id === item.name)) continue
          const directory = await safePath(this.directory, item.name)
          const manifest = await this.readDirectoryManifest(directory)
          if (manifest.id !== item.name) throw new PluginError('Plugin identity mismatch')
          const existing = this.plugins.get(item.name)
          if (existing?.source && ['npm', 'github'].includes(existing.source.type)) throw new PluginError('Plugin identity collision')
          if (existing && !existing.invalid) {
            if (existing.manifest.version !== manifest.version) changed.push(item.name)
            continue
          }
          const entry = manifest.entry ?? 'index.mjs'
          await this.validateEntry(directory, entry)
          const stored = await this.options.storage.getItem<{ enabled?: boolean; configuration?: Record<string, unknown>; source?: PluginSource | { type: 'upload' } }>(`runtime-plugins:${manifest.id}:state`)
          const source = await this.options.storage.getItem<PluginSource | { type: 'upload' }>(`runtime-plugins:${manifest.id}:source`) ?? stored?.source
          // Older uploads already have directory manifests; normalize in memory, without migrating files or state.
          const plugin: InstalledPlugin = { manifest, directory, entry, enabled: false, source: !source || source.type === 'upload' ? { type: 'directory' } : source,
            configuration: validateConfiguration(manifest.configSchema ?? [], stored?.configuration ?? {}, {}, false) }
          this.plugins.set(manifest.id, plugin)
          try { assertCompatibility(manifest) }
          catch (error) {
            plugin.error = error instanceof PluginError ? error.message : 'Plugin compatibility check failed'
            continue
          }
          if (stored?.enabled) activate.add(manifest.id)
        } catch (error) {
          console.warn(`[LLMHub] Failed to discover runtime plugin ${item.name}:`, error)
          if (/^[a-z0-9][a-z0-9-]{1,40}$/.test(item.name) && !this.plugins.has(item.name)) {
            this.plugins.set(item.name, {
              manifest: { id: item.name, name: item.name, version: 'unknown' },
              directory: resolve(this.directory, item.name), entry: 'index.mjs', configuration: {},
              enabled: false, invalid: true, error: 'Invalid plugin manifest, configuration, or path'
            })
          }
        }
      }
      for (const id of changed) {
        try { await this.reloadPlugin(id) }
        catch (error) { this.get(id).error = error instanceof PluginError ? error.message : 'Plugin reload failed' }
      }
      const { cycles } = dependencyOrder([...this.plugins.values()].map(plugin => plugin.manifest))
      for (const [id, error] of cycles) {
        const plugin = this.plugins.get(id)
        if (plugin) { await this.stop(plugin); plugin.error = error }
      }
      for (const plugin of this.ordered(activate)) {
        if (cycles.has(plugin.manifest.id)) continue
        try { await this.start(plugin) }
        catch (error) { plugin.error = error instanceof PluginError ? error.message : 'Plugin activation failed' }
      }
      return this.list()
    })
  }

  private async persist(plugin: InstalledPlugin): Promise<unknown> {
    const sourceKey = `runtime-plugins:${plugin.manifest.id}:source`
    if (this.storageRollback && !this.storageRollback.has(sourceKey)) this.storageRollback.set(sourceKey, await this.options.storage.getItem(sourceKey))
    if (plugin.source) await this.options.storage.setItem(sourceKey, plugin.source)
    return this.options.storage.setItem(`runtime-plugins:${plugin.manifest.id}:state`, { enabled: plugin.enabled, configuration: plugin.configuration })
  }

  private async start(plugin: InstalledPlugin): Promise<void> {
    if (plugin.invalid) throw new PluginError('Invalid plugin manifest, configuration, or path')
    assertCompatibility(plugin.manifest)
    const { cycles } = dependencyOrder([...this.plugins.values()].map(candidate => candidate.manifest))
    if (cycles.has(plugin.manifest.id)) throw new PluginError(cycles.get(plugin.manifest.id)!)
    const issues = dependencyIssues(plugin.manifest, this.list())
    if (issues.length) throw new PluginError(issues.join('; '))
    const runtime: Runtime = { recordListeners: [], metrics: new Map(), accepting: true, active: true, unregister: [], providers: [], protocols: [], ingresses: [], hooks: [], routes: new Map(), listeners: [] }
    plugin.runtime = runtime
    const assertRegistration = () => { if (!runtime.accepting || !runtime.active) throw new PluginError('Plugin registration is closed') }
    const prefix = (id: string) => {
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new PluginError('Invalid registration identifier')
      return `${plugin.manifest.id}:${id}`
    }
    const storageKey = (key: string) => {
      validatePath(key)
      if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(key)) throw new PluginError('Invalid plugin storage key')
      return `runtime-plugins:${plugin.manifest.id}:storage:${key}`
    }
    // Only runtimes started by this transaction participate; unrelated live plugins keep their writes.
    const transactionStorage = this.storageRollback
    const mutateStorage = async (key: string, mutation: () => Promise<unknown>) => {
      const rollback = transactionStorage === this.storageRollback ? transactionStorage : undefined
      if (rollback && !rollback.has(key)) {
        const previous = await this.options.storage.getItem(key)
        if (!rollback.has(key)) rollback.set(key, structuredClone(previous))
      }
      if (!runtime.active) throw new PluginError('Plugin is inactive')
      return mutation()
    }
    const api: PluginAPI = {
      getRecordValues: async (location, recordId) => {
        if (!runtime.active) throw new PluginError('Plugin is inactive')
        const values = await this.readRecordValues(plugin, location, recordId)
        if (!runtime.active) throw new PluginError('Plugin is inactive')
        return values
      },
      getAllRecordValues: async location => {
        if (!runtime.active) throw new PluginError('Plugin is inactive')
        this.recordFields(plugin, location)
        const result: Record<string, PluginRecordValues> = Object.create(null)
        for (const recordId of await this.options.listRecordIds?.(location) ?? []) result[recordId] = await this.readRecordValues(plugin, location, recordId)
        if (!runtime.active) throw new PluginError('Plugin is inactive')
        return result
      },
      onRecordValuesChange: listener => {
        assertRegistration()
        if (typeof listener !== 'function') throw new PluginError('Invalid record values listener')
        runtime.recordListeners.push(listener)
      },
      registerMetric: (key, getter) => {
        assertRegistration()
        if (!plugin.manifest.contributes?.metrics?.some(metric => metric.key === key) || runtime.metrics.has(key) || typeof getter !== 'function') throw new PluginError('Invalid metric registration')
        runtime.metrics.set(key, getter)
      },
      get config() { return Object.freeze(structuredClone(plugin.configuration)) },
      provide: value => {
        assertRegistration()
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginError('Plugin exports must be an object')
        runtime.exports = value
      },
      require: <T extends object = Record<string, unknown>>(id: string): T | undefined => {
        if (!runtime.active) throw new PluginError('Plugin is inactive')
        validateId(id)
        if (!Object.hasOwn(plugin.manifest.dependencies ?? {}, id) && !Object.hasOwn(plugin.manifest.optionalDependencies ?? {}, id)) {
          throw new PluginError('Plugin dependency must be declared')
        }
        const status = this.list().find(record => record.id === plugin.manifest.id)?.dependencies?.find(dependency => dependency.id === id)
        if (!status?.satisfied) return undefined
        const dependency = this.plugins.get(id)
        if (dependency) return (dependency.enabled && dependency.runtime?.active ? dependency.runtime.exports : undefined) as T | undefined
        return this.options.requireBuiltin?.(id) as T | undefined
      },
      registerProvider: definition => {
        assertRegistration()
        const id = prefix(definition.id)
        if (typeof definition.createAdapter !== 'function' || typeof definition.fetchModels !== 'function') throw new PluginError('Invalid provider definition')
        const connectionSchema = validateFields(definition.connectionSchema)
        const secretConnectionFields = [...new Set([...(definition.secretConnectionFields ?? []), ...connectionSchema.filter(field => field.type === 'secret').map(field => `extra.${field.key}`)])]
        runtime.unregister.push(this.options.providerRegistry.register({ ...definition, id, connectionSchema, secretConnectionFields }))
        runtime.providers.push(id)
      },
      registerProtocol: definition => {
        assertRegistration()
        const id = prefix(definition.id)
        runtime.unregister.push(this.protocolRegistry.register({ ...definition, id }))
        runtime.protocols.push(id)
      },
      registerIngress: definition => {
        assertRegistration()
        const id = prefix(definition.id)
        runtime.unregister.push(this.ingressRegistry.register({ ...definition, id }))
        runtime.ingresses.push(id)
      },
      registerHook: hook => {
        assertRegistration()
        const id = prefix(hook.id)
        runtime.unregister.push(this.options.hookRegistry.register({ ...hook, id }))
        runtime.hooks.push(id)
      },
      registerRoute: (method, path, handler) => {
        assertRegistration()
        const key = `${method.toUpperCase()} ${validatePath(path.replace(/^\//, ''))}`
        if (!/^[A-Z]+ /.test(key) || typeof handler !== 'function' || runtime.routes.has(key)) throw new PluginError('Invalid plugin route')
        runtime.routes.set(key, handler)
      },
      onConfigChange: listener => { assertRegistration(); if (typeof listener !== 'function') throw new PluginError('Invalid configuration listener'); runtime.listeners.push(listener) },
      storage: {
        getItem: key => { if (!runtime.active) throw new PluginError('Plugin is inactive'); return this.options.storage.getItem(storageKey(key)) },
        setItem: (key, value) => {
          if (!runtime.active) throw new PluginError('Plugin is inactive')
          const namespacedKey = storageKey(key)
          return mutateStorage(namespacedKey, () => this.options.storage.setItem(namespacedKey, value))
        },
        removeItem: key => {
          if (!runtime.active) throw new PluginError('Plugin is inactive')
          const namespacedKey = storageKey(key)
          return mutateStorage(namespacedKey, () => this.options.storage.removeItem(namespacedKey))
        }
      },
      logger: {
        info: (...values: unknown[]) => console.info(`[Plugin ${plugin.manifest.id}]`, ...values),
        warn: (...values: unknown[]) => console.warn(`[Plugin ${plugin.manifest.id}]`, ...values),
        error: (...values: unknown[]) => console.error(`[Plugin ${plugin.manifest.id}]`, ...values)
      }
    }
    try {
      plugin.configuration = validateConfiguration(plugin.manifest.configSchema ?? [], plugin.configuration)
      await this.bounded((async () => {
        const module = await this.loadModule(plugin.directory, plugin.entry, plugin.isolateModules ? runtime : undefined)
        assertRegistration()
        const setup = module.default?.setup
        if (typeof setup !== 'function') throw new PluginError('Plugin setup missing')
        const cleanup = await setup(api)
        if (typeof cleanup === 'function') {
          if (runtime.active) runtime.cleanup = cleanup
          else await this.bounded(Promise.resolve().then(cleanup), true).catch(() => {})
        }
      })().finally(async () => {
        if (!runtime.active) await runtime.moduleGeneration?.dispose()
      }))
      runtime.accepting = false
      plugin.enabled = true
      plugin.error = undefined
      this.options.onRegistryChange?.()
    } catch (error) {
      console.error(`[LLMHub] Runtime plugin ${plugin.manifest.id} failed to activate:`, error)
      await this.stop(plugin)
      const message = error instanceof PluginError ? `Plugin activation failed: ${error.message}` : 'Plugin activation failed (see server log)'
      plugin.error = message
      throw new PluginError(message)
    }
  }

  private async stop(plugin: InstalledPlugin): Promise<void> {
    const runtime = plugin.runtime
    plugin.enabled = false
    plugin.runtime = undefined
    if (!runtime) return
    runtime.exports = undefined
    runtime.active = false
    runtime.accepting = false
    runtime.routes.clear()
    runtime.listeners.length = 0
    runtime.recordListeners.length = 0
    runtime.metrics.clear()
    for (const unregister of runtime.unregister.reverse()) {
      try { await this.bounded(Promise.resolve().then(unregister), true) } catch { plugin.error = 'Plugin cleanup failed' }
    }
    try { this.options.onRegistryChange?.() } catch { plugin.error = 'Plugin registry notification failed' }
    if (runtime.cleanup) {
      const cleanup = Promise.resolve().then(runtime.cleanup).finally(() => runtime.moduleGeneration?.dispose())
      try { await this.bounded(cleanup, true) } catch { plugin.error = 'Plugin cleanup failed' }
    }
    try { await runtime.moduleGeneration?.dispose() } catch { plugin.error = 'Plugin generation cleanup failed' }
  }

  enable(id: string): Promise<PluginRecord[]> {
    return this.serial(id, async () => {
      const plugin = this.get(id)
      plugin.installed = false
      if (!plugin.enabled) {
        try { await this.start(plugin) }
        catch (error) {
          plugin.error = error instanceof PluginError ? error.message : 'Plugin activation failed'
          throw error
        }
      }
      try { await this.persist(plugin) } catch { await this.stop(plugin); throw new PluginError('Plugin persistence failed') }
      return this.list()
    })
  }

  disable(id: string): Promise<PluginRecord[]> {
    return this.serial(id, async () => { const plugin = this.get(id); this.assertRemovable(id); await this.stop(plugin); await this.persist(plugin); return this.list() })
  }

  reload(id: string): Promise<PluginRecord[]> {
    return this.serial(id, async () => { await this.reloadPlugin(id); return this.list() })
  }

  private async reloadPlugin(id: string): Promise<void> {
    const plugin = this.get(id)
    const manifest = plugin.source && ['npm', 'github'].includes(plugin.source.type)
      ? (await discoverPackages(this.directory)).find(candidate => candidate.manifest.id === id)?.manifest
      : await this.readDirectoryManifest(plugin.directory)
    if (!manifest) throw new PluginError('Plugin manifest not found')
    if (manifest.id !== id) throw new PluginError('Plugin identity mismatch')
    this.assertVersion(plugin.manifest, manifest)
    const { cycles } = dependencyOrder([...this.plugins.values()].map(candidate => candidate === plugin ? manifest : candidate.manifest))
    if (cycles.has(id)) throw new PluginError(cycles.get(id)!)
    const entry = manifest.entry ?? 'index.mjs'
    await this.validateEntry(plugin.directory, entry)
    const configuration = validateConfiguration(manifest.configSchema ?? [], plugin.configuration, {}, false)
    const affected = this.affected(id)
    const enabled = new Set(affected.filter(candidate => candidate.enabled).map(candidate => candidate.manifest.id))
    for (const candidate of [...affected].reverse()) await this.stop(candidate)
    plugin.manifest = manifest
    plugin.isolateModules = true
    plugin.entry = entry
    plugin.configuration = configuration
    plugin.invalid = false
    plugin.error = undefined
    let failure: unknown
    for (const candidate of this.ordered(enabled)) {
      try { await this.start(candidate) }
      catch (error) {
        candidate.error = error instanceof PluginError ? error.message : 'Plugin activation failed'
        failure ??= error
      }
    }
    try { await this.persist(plugin) }
    catch {
      for (const candidate of [...this.ordered(enabled)].reverse()) await this.stop(candidate)
      throw new PluginError('Plugin persistence failed')
    }
    if (failure) throw failure
  }

  uninstall(id: string): Promise<PluginRecord[]> {
    return this.serial(id, async () => {
      const source = this.get(id).source
      if (source && ['npm', 'github'].includes(source.type)) return this.uninstallPackage(id)
      const plugin = this.get(id)
      this.assertRemovable(id)
      await this.stop(plugin)
      await this.persist(plugin)
      const directory = await safePath(this.directory, id)
      await rm(directory, { recursive: true })
      const prefix = `runtime-plugins:${id}:storage:`
      const keys = await this.options.storage.getKeys?.(prefix) ?? []
      for (const key of keys) await this.options.storage.removeItem(key)
      await this.options.storage.removeItem(recordValuesKey(id))
      await this.options.storage.removeItem(`runtime-plugins:${id}:state`)
      await this.options.storage.removeItem(`runtime-plugins:${id}:source`)
      this.plugins.delete(id)
      return this.list()
    })
  }

  listContributions(): PluginContributionRecord[] {
    return [...this.plugins.values()].filter(plugin => plugin.enabled && plugin.runtime?.active && plugin.manifest.contributes)
      .map(plugin => ({ id: plugin.manifest.id, name: plugin.manifest.name ?? plugin.manifest.id, contributes: structuredClone(plugin.manifest.contributes!) }))
  }

  private recordFields(plugin: InstalledPlugin, location: PluginRecordLocation) {
    if (!['models', 'apiKeys', 'providers'].includes(location)) throw new PluginError('Unknown contribution location')
    const fields = plugin.manifest.contributes?.[location]
    if (!fields) throw new PluginError('Contribution location not found')
    return fields
  }

  private async recordExists(location: PluginRecordLocation, recordId: string): Promise<boolean> {
    if (typeof recordId !== 'string' || !recordId || recordId.length > 2000 || /[\u0000-\u001f]/.test(recordId) || ['__proto__', 'constructor', 'prototype'].includes(recordId)) throw new PluginError('Invalid record identifier')
    return (await this.options.listRecordIds?.(location))?.includes(recordId) ?? false
  }

  private async readRecordValues(plugin: InstalledPlugin, location: PluginRecordLocation, recordId: string): Promise<PluginRecordValues> {
    const fields = this.recordFields(plugin, location)
    if (!await this.recordExists(location, recordId)) return validateConfiguration(fields, {}, {}, false)
    const stored = await this.options.storage.getItem<StoredRecordValues>(recordValuesKey(plugin.manifest.id))
    const previous = stored?.[location]?.[recordId] ?? {}
    // Removed schema keys must not leak through after a plugin upgrade.
    const selected = Object.fromEntries(fields.filter(field => Object.hasOwn(previous, field.key)).map(field => [field.key, previous[field.key]]))
    return validateConfiguration(fields, selected, {}, false)
  }

  private enabledContributionPlugin(id: string): InstalledPlugin {
    const plugin = this.get(id)
    if (!plugin.enabled || !plugin.runtime?.active) throw new PluginError('Plugin contributions not found')
    return plugin
  }

  async getRecordValues(id: string, location: PluginRecordLocation, recordId: string): Promise<PluginRecordValues> {
    const plugin = this.enabledContributionPlugin(id)
    const values = await this.readRecordValues(plugin, location, recordId)
    for (const field of this.recordFields(plugin, location)) if (field.type === 'secret') delete values[field.key]
    return values
  }

  updateRecordValues(id: string, location: PluginRecordLocation, recordId: string, input: unknown): Promise<PluginRecordValues> {
    return this.serial(id, async () => {
      const plugin = this.enabledContributionPlugin(id)
      const fields = this.recordFields(plugin, location)
      const values = await withRecordValuesLock(async () => {
        if (!await this.recordExists(location, recordId)) throw new PluginError('Contribution record not found')
        const previous = await this.readRecordValues(plugin, location, recordId)
        const values = validateConfiguration(fields, input, previous)
        const key = recordValuesKey(id)
        const stored = await this.options.storage.getItem<StoredRecordValues>(key) ?? {}
        stored[location] ??= {}
        stored[location]![recordId] = values
        await this.options.storage.setItem(key, stored)
        return values
      })
      for (const listener of plugin.runtime?.recordListeners ?? []) {
        try { await this.bounded(Promise.resolve().then(() => listener({ location, recordId, values: Object.freeze(structuredClone(values)) }))) }
        catch { throw new PluginError('Plugin record values saved, but a change listener failed') }
      }
      const result = structuredClone(values)
      for (const field of fields) if (field.type === 'secret') delete result[field.key]
      return result
    })
  }

  async getMetrics(): Promise<PluginMetricResult[]> {
    const operations: Promise<PluginMetricResult>[] = []
    for (const plugin of this.plugins.values()) {
      const runtime = plugin.runtime
      if (!plugin.enabled || !runtime?.active) continue
      for (const metric of plugin.manifest.contributes?.metrics ?? []) {
        operations.push((async () => {
          const result: PluginMetricResult = { pluginId: plugin.manifest.id, ...metric, value: null }
          try {
            const getter = runtime.metrics.get(metric.key)
            if (!getter) throw new PluginError('Metric is not registered')
            const value = await this.bounded(Promise.resolve().then(getter))
            if (!runtime.active || plugin.runtime !== runtime) throw new PluginError('Plugin is inactive')
            if (value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) throw new PluginError('Invalid metric value')
            result.value = value
          } catch { result.error = 'Metric unavailable' }
          return result
        })())
      }
    }
    return Promise.all(operations)
  }

  resolvePanel(id: string, panelId: string): Promise<string> {
    return this.serial(id, async () => {
      const plugin = this.enabledContributionPlugin(id)
      const panel = plugin.manifest.contributes?.panels?.find(panel => panel.id === panelId)
      if (!panel) throw new PluginError('Plugin panel not found')
      const filename = await safePath(plugin.directory, validatePath(panel.page))
      if (!filename.endsWith('.html') || !(await lstat(filename)).isFile()) throw new PluginError('Invalid plugin panel')
      return filename
    })
  }

  getConfig(id: string): Record<string, unknown> {
    const plugin = this.get(id)
    const result = structuredClone(plugin.configuration)
    for (const field of plugin.manifest.configSchema ?? []) if (field.type === 'secret') delete result[field.key]
    return result
  }

  updateConfig(id: string, input: unknown): Promise<Record<string, unknown>> {
    return this.serial(id, async () => {
      const plugin = this.get(id)
      const previous = plugin.configuration
      plugin.configuration = validateConfiguration(plugin.manifest.configSchema ?? [], input, previous)
      try { await this.persist(plugin) } catch { plugin.configuration = previous; throw new PluginError('Plugin persistence failed') }
      try {
        for (const listener of plugin.runtime?.listeners ?? []) await this.bounded(Promise.resolve().then(() => listener(Object.freeze(structuredClone(plugin.configuration)))))
      } catch (error) {
        console.error(`[LLMHub] Runtime plugin ${id} configuration callback failed:`, error)
        const affected = this.affected(id)
        const enabled = affected.filter(candidate => candidate.enabled).map(candidate => candidate.manifest.id)
        for (const candidate of [...affected].reverse()) await this.stop(candidate)
        plugin.error = 'Plugin configuration callback failed'
        for (const candidate of this.ordered(enabled)) {
          if (candidate === plugin) continue
          try { await this.start(candidate) }
          catch (activationError) { candidate.error = activationError instanceof PluginError ? activationError.message : 'Plugin activation failed' }
        }
        await this.persist(plugin)
        throw new PluginError('Plugin configuration callback failed')
      }
      return this.getConfig(id)
    })
  }

  dispatchRoute(id: string, method: string, path: string, event: H3Event): Promise<unknown> {
    if (this.options.builtinPlugins?.().some(plugin => plugin.id === id)) {
      return Promise.resolve().then(() => {
        if (!this.options.dispatchBuiltinRoute) throw new PluginError('Plugin route not found')
        return this.options.dispatchBuiltinRoute(id, method, path, event)
      })
    }
    return this.serial(id, async () => {
      const plugin = this.get(id)
      const handler = plugin.enabled ? plugin.runtime?.routes.get(`${method.toUpperCase()} ${validatePath(path)}`) : undefined
      if (!handler) throw new PluginError('Plugin route not found')
      return this.bounded(Promise.resolve().then(() => handler(event)))
    })
  }

  resolvePage(id: string, path: string): Promise<string> {
    return this.serial(id, async () => {
      const plugin = this.get(id)
      if (!plugin.enabled || !plugin.manifest.ui) throw new PluginError('Plugin page not found')
      const page = validatePath(plugin.manifest.ui.page)
      const requested = validatePath(path || page)
      const assets = dirname(page)
      if (requested !== page && (assets === '.' || !requested.startsWith(`${assets}/`))) throw new PluginError('Plugin asset not found')
      if (!/\.(html|css|js|svg|png|jpg|json|woff2)$/.test(basename(requested))) throw new PluginError('Invalid plugin asset')
      const filename = await safePath(plugin.directory, requested)
      if (!(await lstat(filename)).isFile()) throw new PluginError('Invalid plugin asset')
      return filename
    })
  }

  async shutdown(): Promise<void> {
    await this.serial('$shutdown', async () => {
      for (const plugin of this.ordered(this.plugins.keys()).reverse()) await this.stop(plugin)
    })
  }
}
