import { mkdir, readdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises'
import { resolve, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { gt, valid } from 'semver'
import { createModuleGeneration, type ModuleGeneration } from './module-generation'
import { assertCompatibility, decorateRecords, dependencyIssues, dependencyOrder, manifestWarnings } from './dependencies'
import type { H3Event } from 'h3'
import type { ProviderDefinition, ProviderRegistry } from '../core/registry'
import type { RequestHook, HookRegistry } from '../core/hooks'
import { ProtocolRegistry, type ProtocolDefinition } from '../core/protocol-registry'
import { IngressRegistry, type IngressDefinition } from '../core/ingress-registry'
import type { PluginManifest, PluginRecord } from '../../shared/types/plugin'
import { PluginError, safePath, validatePath, validateId, validateManifest, parseUploadedManifest, validateFields, validateConfiguration } from './manifest'

export interface PluginStorage {
  getItem<T>(key: string): Promise<T | null>
  setItem<T>(key: string, value: T): Promise<unknown>
  removeItem(key: string): Promise<unknown>
  getKeys?(prefix: string): Promise<string[]>
}
type Cleanup = () => void | Promise<void>
type RouteHandler = (event: H3Event) => unknown | Promise<unknown>
export interface PluginAPI {
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
  manifest?: PluginManifest
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
  isolateModules?: boolean
}
interface Runtime {
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
      warnings: manifestWarnings(plugin.manifest), enabled: plugin.enabled, status: plugin.error ? 'error' : plugin.enabled ? 'enabled' : plugin.installed ? 'installed' : 'disabled', error: plugin.error,
      providers: [...(plugin.runtime?.providers ?? [])], hooks: [...(plugin.runtime?.hooks ?? [])],
      protocols: [...(plugin.runtime?.protocols ?? [])], ingresses: [...(plugin.runtime?.ingresses ?? [])] }))
    return decorateRecords([...(this.options.builtinPlugins?.() ?? []), ...runtimePlugins])
  }

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
  }

  private async loadModule(directory: string, entry: string, runtime?: Runtime): Promise<PluginModule> {
    const filename = await safePath(directory, entry)
    if (!filename.endsWith('.mjs') || !(await lstat(filename)).isFile()) throw new PluginError('Invalid plugin entry')
    if (!runtime) return this.bounded(importModule(`${pathToFileURL(filename).href}?generation=${randomUUID()}`))
    const generation = await createModuleGeneration(directory)
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
      const changed: string[] = []
      // Discover every manifest before activating anything: filesystem order is not dependency order.
      for (const item of await readdir(this.directory, { withFileTypes: true })) {
        if (!item.isDirectory() || item.name.startsWith('.')) continue
        try {
          validateId(item.name)
          if (this.options.builtinPlugins?.().some(plugin => plugin.id === item.name)) continue
          const directory = await safePath(this.directory, item.name)
          const manifest = validateManifest(JSON.parse(await readFile(await safePath(directory, 'plugin.json'), 'utf8')))
          if (manifest.id !== item.name) throw new PluginError('Plugin identity mismatch')
          const existing = this.plugins.get(item.name)
          if (existing && !existing.invalid) {
            if (existing.manifest.version !== manifest.version) changed.push(item.name)
            continue
          }
          const entry = manifest.entry ?? 'index.mjs'
          await safePath(directory, entry)
          const stored = await this.options.storage.getItem<{ enabled?: boolean; configuration?: Record<string, unknown> }>(`runtime-plugins:${manifest.id}:state`)
          const plugin: InstalledPlugin = { manifest, directory, entry, enabled: false,
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

  async install(source: Buffer, force = false): Promise<PluginRecord> {
    return this.serial('$install', async () => {
      if (!Buffer.isBuffer(source) || !source.length || source.length > 1024 * 1024) throw new PluginError('Invalid plugin upload')
      const manifest = validateManifest(parseUploadedManifest(source.toString('utf8')), true)
      this.assertRuntimePlugin(manifest.id)
      assertCompatibility(manifest)
      manifest.entry = 'index.mjs'
      if (manifest.ui) throw new PluginError('Plugin assets require directory installation')
      const previous = this.plugins.get(manifest.id)
      if (previous) {
        const sameVersion = previous.manifest.version === manifest.version || (valid(previous.manifest.version) && !gt(previous.manifest.version, manifest.version) && !gt(manifest.version, previous.manifest.version))
        if (sameVersion && !force) throw new PluginError('Plugin already installed')
        this.assertVersion(previous.manifest, manifest, force)
      }
      const configuration = validateConfiguration(manifest.configSchema ?? [], previous?.configuration ?? {}, {}, false)
      const records = this.list().filter(record => record.id !== manifest.id)
      const issues = dependencyIssues(manifest, records)
      if (issues.length) throw new PluginError(issues.join('; '))
      const { cycles } = dependencyOrder([...records.map(record => record.manifest), manifest])
      if (cycles.has(manifest.id)) throw new PluginError(cycles.get(manifest.id)!)
      await this.prepareDirectory()
      const directory = resolve(this.directory, `.install-${randomUUID()}`)
      const target = resolve(this.directory, manifest.id)
      const backup = resolve(this.directory, `.backup-${randomUUID()}`)
      const affected = this.affected(manifest.id)
      const enabled = new Set(affected.filter(plugin => plugin.enabled).map(plugin => plugin.manifest.id))
      const stateKey = `runtime-plugins:${manifest.id}:state`
      const previousState = await this.options.storage.getItem(stateKey)
      let backedUp = false
      let moved = false
      let stopped = false
      await mkdir(directory)
      try {
        await writeFile(resolve(directory, 'index.mjs'), source, { flag: 'wx', mode: 0o600 })
        await writeFile(resolve(directory, 'plugin.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
        const module = await this.loadModule(directory, 'index.mjs')
        if (typeof module.default?.setup !== 'function') throw new PluginError('Plugin setup missing')
        for (const plugin of [...affected].reverse()) await this.stop(plugin)
        stopped = affected.length > 0
        if (previous) {
          await safePath(this.directory, manifest.id)
          await rename(target, backup)
          backedUp = true
        } else {
          try { await lstat(target); throw new PluginError('Plugin already installed') }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
        await rename(directory, target)
        moved = true
        const plugin: InstalledPlugin = { manifest, directory: target, entry: 'index.mjs', configuration, enabled: false, installed: !previous }
        this.plugins.set(manifest.id, plugin)
        this.storageRollback = new Map()
        if (previous && !enabled.has(manifest.id)) {
          // Validate replacement setup transactionally without changing the persisted disabled state.
          await this.start(plugin)
          await this.stop(plugin)
        }
        for (const candidate of this.ordered(enabled)) await this.start(candidate)
        await this.persist(plugin)
      } catch (error) {
        if (moved) {
          for (const plugin of [...this.ordered(enabled)].reverse()) await this.stop(plugin)
          await rm(target, { recursive: true, force: true })
        }
        if (backedUp) await rename(backup, target)
        if (previous) this.plugins.set(manifest.id, previous)
        else this.plugins.delete(manifest.id)
        if (moved || stopped) {
          let rollbackFailed = false
          const storageRollback = this.storageRollback
          this.storageRollback = undefined
          for (const [key, value] of storageRollback ?? []) {
            try {
              if (value === null) await this.options.storage.removeItem(key)
              else await this.options.storage.setItem(key, value)
            } catch (rollbackError) {
              rollbackFailed = true
              console.error('[LLMHub] Plugin upgrade storage rollback failed:', rollbackError)
            }
          }
          try {
            if (previousState === null) await this.options.storage.removeItem(stateKey)
            else await this.options.storage.setItem(stateKey, previousState)
          } catch (rollbackError) {
            rollbackFailed = true
            console.error('[LLMHub] Plugin upgrade state rollback failed:', rollbackError)
          }
          // A storage failure must not prevent restoring the previous live implementation.
          for (const plugin of this.ordered(enabled)) {
            try { await this.start(plugin) }
            catch (rollbackError) {
              rollbackFailed = true
              plugin.error = rollbackError instanceof PluginError ? rollbackError.message : 'Plugin rollback activation failed'
              console.error('[LLMHub] Plugin upgrade runtime rollback failed:', rollbackError)
            }
          }
          if (rollbackFailed) throw new PluginError('Plugin upgrade failed and rollback could not fully restore runtime or state')
        }
        throw error
      } finally {
        this.storageRollback = undefined
        if (!moved) await rm(directory, { recursive: true, force: true })
      }
      if (backedUp) await rm(backup, { recursive: true, force: true })
      return this.list().find(record => record.id === manifest.id)!
    })
  }

  private persist(plugin: InstalledPlugin): Promise<unknown> {
    return this.options.storage.setItem(`runtime-plugins:${plugin.manifest.id}:state`, { enabled: plugin.enabled, configuration: plugin.configuration })
  }

  private async start(plugin: InstalledPlugin): Promise<void> {
    if (plugin.invalid) throw new PluginError('Invalid plugin manifest, configuration, or path')
    assertCompatibility(plugin.manifest)
    const { cycles } = dependencyOrder([...this.plugins.values()].map(candidate => candidate.manifest))
    if (cycles.has(plugin.manifest.id)) throw new PluginError(cycles.get(plugin.manifest.id)!)
    const issues = dependencyIssues(plugin.manifest, this.list())
    if (issues.length) throw new PluginError(issues.join('; '))
    const runtime: Runtime = { accepting: true, active: true, unregister: [], providers: [], protocols: [], ingresses: [], hooks: [], routes: new Map(), listeners: [] }
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
      if (!plugin.enabled) await this.start(plugin)
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
    const manifest = validateManifest(JSON.parse(await readFile(await safePath(plugin.directory, 'plugin.json'), 'utf8')))
    if (manifest.id !== id) throw new PluginError('Plugin identity mismatch')
    this.assertVersion(plugin.manifest, manifest)
    const entry = manifest.entry ?? 'index.mjs'
    await safePath(plugin.directory, entry)
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
      const plugin = this.get(id)
      this.assertRemovable(id)
      await this.stop(plugin)
      await this.persist(plugin)
      const directory = await safePath(this.directory, id)
      await rm(directory, { recursive: true })
      const prefix = `runtime-plugins:${id}:storage:`
      const keys = await this.options.storage.getKeys?.(prefix) ?? []
      for (const key of keys) await this.options.storage.removeItem(key)
      await this.options.storage.removeItem(`runtime-plugins:${id}:state`)
      this.plugins.delete(id)
      return this.list()
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
