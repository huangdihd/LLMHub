import { mkdir, readdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises'
import { resolve, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import type { ProviderDefinition, ProviderRegistry } from '../core/registry'
import type { RequestHook, HookRegistry } from '../core/hooks'
import type { PluginManifest, PluginRecord } from '../../shared/types/plugin'
import { PluginError, safePath, validatePath, validateId, validateManifest, validateFields, validateConfiguration } from './manifest'

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
  registerProvider(definition: ProviderDefinition): void
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
}
interface Runtime {
  accepting: boolean
  active: boolean
  unregister: Cleanup[]
  cleanup?: Cleanup
  providers: string[]
  hooks: string[]
  routes: Map<string, RouteHandler>
  listeners: Array<(configuration: Readonly<Record<string, unknown>>) => void | Promise<void>>
}
export interface PluginManagerOptions {
  directory?: string
  rootDirectory?: string
  storage: PluginStorage
  providerRegistry: ProviderRegistry
  hookRegistry: HookRegistry
  timeoutMs?: number
  cleanupTimeoutMs?: number
  onRegistryChange?: () => void
}
const importModule = new Function('url', 'return import(url)') as (url: string) => Promise<PluginModule>

export class PluginManager {
  private readonly options: PluginManagerOptions
  private readonly directory: string
  private readonly plugins = new Map<string, InstalledPlugin>()
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(options: PluginManagerOptions) {
    this.options = options
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
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(operation).catch(error => {
      if (error instanceof PluginError) throw error
      // Plugin-thrown errors may carry secrets: log them server-side, never return them.
      console.error(`[LLMHub] Runtime plugin operation failed (${id}):`, error)
      throw new PluginError('Plugin operation failed')
    })
    this.queues.set(id, next)
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id) }).catch(() => {})
    return next
  }

  private get(id: string): InstalledPlugin {
    validateId(id)
    const plugin = this.plugins.get(id)
    if (!plugin) throw new PluginError('Plugin not found')
    return plugin
  }

  list(): PluginRecord[] {
    return [...this.plugins.values()].map(plugin => ({ id: plugin.manifest.id, manifest: structuredClone(plugin.manifest),
      enabled: plugin.enabled, status: plugin.error ? 'error' : plugin.enabled ? 'enabled' : plugin.installed ? 'installed' : 'disabled', error: plugin.error,
      providers: [...(plugin.runtime?.providers ?? [])], hooks: [...(plugin.runtime?.hooks ?? [])] }))
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

  private async loadModule(directory: string, entry: string): Promise<PluginModule> {
    const filename = await safePath(directory, entry)
    if (!filename.endsWith('.mjs') || !(await lstat(filename)).isFile()) throw new PluginError('Invalid plugin entry')
    return this.bounded(importModule(`${pathToFileURL(filename).href}?generation=${randomUUID()}`))
  }

  async scan(): Promise<PluginRecord[]> {
    return this.serial('$scan', async () => {
      await this.prepareDirectory()
      for (const item of await readdir(this.directory, { withFileTypes: true })) {
        if (!item.isDirectory() || item.name.startsWith('.')) continue
        try {
          validateId(item.name)
          await this.serial(item.name, async () => {
            if (this.plugins.has(item.name)) return
            const directory = await safePath(this.directory, item.name)
            const manifest = validateManifest(JSON.parse(await readFile(await safePath(directory, 'plugin.json'), 'utf8')))
            if (manifest.id !== item.name) throw new PluginError('Plugin identity mismatch')
            const entry = manifest.entry ?? 'index.mjs'
            await safePath(directory, entry)
            const stored = await this.options.storage.getItem<{ enabled?: boolean; configuration?: Record<string, unknown> }>(`runtime-plugins:${manifest.id}:state`)
            const plugin: InstalledPlugin = { manifest, directory, entry, enabled: false,
              configuration: validateConfiguration(manifest.configSchema ?? [], stored?.configuration ?? {}, {}, false) }
            this.plugins.set(manifest.id, plugin)
            if (stored?.enabled) {
              try { await this.start(plugin) } catch (error) { plugin.error = error instanceof PluginError ? error.message : 'Plugin activation failed' }
            }
          })
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
      return this.list()
    })
  }

  async install(source: Buffer): Promise<PluginRecord> {
    return this.serial('$install', async () => {
      if (!Buffer.isBuffer(source) || !source.length || source.length > 1024 * 1024) throw new PluginError('Invalid plugin upload')
      await this.prepareDirectory()
      const temporary = `.install-${randomUUID()}`
      await mkdir(resolve(this.directory, temporary))
      const directory = await safePath(this.directory, temporary)
      let moved = false
      try {
        await writeFile(resolve(directory, 'index.mjs'), source, { flag: 'wx', mode: 0o600 })
        const module = await this.loadModule(directory, 'index.mjs')
        const manifest = validateManifest(module.manifest)
        if (typeof module.default?.setup !== 'function') throw new PluginError('Plugin setup missing')
        manifest.entry = 'index.mjs'
        // Single-file uploads cannot supply static assets.
        if (manifest.ui) throw new PluginError('Plugin assets require directory installation')
        return await this.serial(manifest.id, async () => {
          if (this.plugins.has(manifest.id)) throw new PluginError('Plugin already installed')
          await writeFile(resolve(directory, 'plugin.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
          const target = resolve(this.directory, manifest.id)
          try { await lstat(target); throw new PluginError('Plugin already installed') }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          await safePath(this.directory)
          await rename(directory, target)
          moved = true
          const plugin: InstalledPlugin = { manifest, directory: target, entry: 'index.mjs', enabled: false, installed: true,
            configuration: validateConfiguration(manifest.configSchema ?? [], {}, {}, false) }
          try { await this.persist(plugin) }
          catch {
            await safePath(this.directory, manifest.id)
            await rename(target, directory)
            moved = false
            throw new PluginError('Plugin persistence failed')
          }
          this.plugins.set(manifest.id, plugin)
          return this.list().find(record => record.id === manifest.id)!
        })
      } finally {
        if (!moved) { await safePath(this.directory, temporary); await rm(directory, { recursive: true, force: true }) }
      }
    })
  }

  private persist(plugin: InstalledPlugin): Promise<unknown> {
    return this.options.storage.setItem(`runtime-plugins:${plugin.manifest.id}:state`, { enabled: plugin.enabled, configuration: plugin.configuration })
  }

  private async start(plugin: InstalledPlugin): Promise<void> {
    if (plugin.invalid) throw new PluginError('Invalid plugin manifest, configuration, or path')
    const runtime: Runtime = { accepting: true, active: true, unregister: [], providers: [], hooks: [], routes: new Map(), listeners: [] }
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
    const api: PluginAPI = {
      get config() { return Object.freeze(structuredClone(plugin.configuration)) },
      registerProvider: definition => {
        assertRegistration()
        const id = prefix(definition.id)
        if (typeof definition.createAdapter !== 'function' || typeof definition.fetchModels !== 'function') throw new PluginError('Invalid provider definition')
        const connectionSchema = validateFields(definition.connectionSchema)
        const secretConnectionFields = [...new Set([...(definition.secretConnectionFields ?? []), ...connectionSchema.filter(field => field.type === 'secret').map(field => `extra.${field.key}`)])]
        runtime.unregister.push(this.options.providerRegistry.register({ ...definition, id, connectionSchema, secretConnectionFields }))
        runtime.providers.push(id)
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
        setItem: (key, value) => { if (!runtime.active) throw new PluginError('Plugin is inactive'); return this.options.storage.setItem(storageKey(key), value) },
        removeItem: key => { if (!runtime.active) throw new PluginError('Plugin is inactive'); return this.options.storage.removeItem(storageKey(key)) }
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
        const module = await this.loadModule(plugin.directory, plugin.entry)
        assertRegistration()
        const setup = module.default?.setup
        if (typeof setup !== 'function') throw new PluginError('Plugin setup missing')
        const cleanup = await setup(api)
        if (typeof cleanup === 'function') {
          if (runtime.active) runtime.cleanup = cleanup
          else await this.bounded(Promise.resolve().then(cleanup), true).catch(() => {})
        }
      })())
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
    runtime.active = false
    runtime.accepting = false
    runtime.routes.clear()
    runtime.listeners.length = 0
    for (const unregister of runtime.unregister.reverse()) {
      try { await this.bounded(Promise.resolve().then(unregister), true) } catch { plugin.error = 'Plugin cleanup failed' }
    }
    try { this.options.onRegistryChange?.() } catch { plugin.error = 'Plugin registry notification failed' }
    if (runtime.cleanup) {
      try { await this.bounded(Promise.resolve().then(runtime.cleanup), true) } catch { plugin.error = 'Plugin cleanup failed' }
    }
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
    return this.serial(id, async () => { const plugin = this.get(id); await this.stop(plugin); await this.persist(plugin); return this.list() })
  }

  reload(id: string): Promise<PluginRecord[]> {
    return this.serial(id, async () => {
      const plugin = this.get(id)
      const enabled = plugin.enabled
      await this.stop(plugin)
      const manifest = validateManifest(JSON.parse(await readFile(await safePath(plugin.directory, 'plugin.json'), 'utf8')))
      if (manifest.id !== id) throw new PluginError('Plugin identity mismatch')
      plugin.manifest = manifest
      plugin.entry = manifest.entry ?? 'index.mjs'
      plugin.invalid = false
      plugin.error = undefined
      if (enabled) await this.start(plugin)
      try { await this.persist(plugin) } catch { await this.stop(plugin); throw new PluginError('Plugin persistence failed') }
      return this.list()
    })
  }

  uninstall(id: string): Promise<PluginRecord[]> {
    return this.serial(id, async () => {
      const plugin = this.get(id)
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
        await this.stop(plugin)
        plugin.error = 'Plugin configuration callback failed'
        await this.persist(plugin)
        throw new PluginError('Plugin configuration callback failed')
      }
      return this.getConfig(id)
    })
  }

  dispatchRoute(id: string, method: string, path: string, event: H3Event): Promise<unknown> {
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
    await Promise.all([...this.plugins.keys()].map(id => this.serial(id, () => this.stop(this.get(id)))))
  }
}
