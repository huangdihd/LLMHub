import type { H3Event } from 'h3'
import type { HookRegistry } from '../server/core/hooks'
import type { ProviderRegistry } from '../server/core/registry'
import { ProtocolRegistry } from '../server/core/protocol-registry'
import { IngressRegistry } from '../server/core/ingress-registry'
import type { PluginAPI, PluginStorage } from '../server/plugins-runtime/manager'
import { PluginError, validateId, validatePath, validateManifest } from '../server/plugins-runtime/manifest'
import type { PluginRecord } from '../shared/types/plugin'
import { assertCompatibility, decorateRecords, dependencyIssues } from '../server/plugins-runtime/dependencies'
import type { BuiltinPlugin } from './catalog'

export interface BuiltinHostOptions {
  pluginOrder?: readonly string[]
  hookRegistry: HookRegistry
  providerRegistry: ProviderRegistry
  protocolRegistry?: ProtocolRegistry
  ingressRegistry?: IngressRegistry
  storage: PluginStorage
}

/** Built-ins use the runtime setup contract without installable-file lifecycle controls. */
export class BuiltinPluginHost {
  private readonly records = new Map<string, PluginRecord>()
  private readonly routes = new Map<string, (event: H3Event) => unknown | Promise<unknown>>()

  private readonly exports = new Map<string, object>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly disposers = new Map<string, () => Promise<void>>()
  private closing = false
  private shutdownPromise?: Promise<void>

  private readonly protocolRegistry: ProtocolRegistry
  private readonly ingressRegistry: IngressRegistry

  constructor(private readonly options: BuiltinHostOptions) {
    this.protocolRegistry = options.protocolRegistry ?? new ProtocolRegistry()
    this.ingressRegistry = options.ingressRegistry ?? new IngressRegistry()
  }

  async register(plugin: BuiltinPlugin): Promise<void> {
    if (this.closing) throw new PluginError('Builtin host is shutting down')
    const manifest = validateManifest({ ...plugin.manifest, name: plugin.manifest.name ?? plugin.manifest.id }, true)
    assertCompatibility(manifest)
    const id = manifest.id
    if (this.records.has(id) || this.pending.has(id)) throw new PluginError(`Builtin plugin already registered: ${id}`)
    // Defer setup until the pending reservation exists, including for reentrant setup.
    const operation = Promise.resolve().then(() => this.setup({ ...plugin, manifest }))
    this.pending.set(id, operation)
    try { await operation }
    finally { this.pending.delete(id) }
  }

  private async setup(plugin: BuiltinPlugin): Promise<void> {
    const id = plugin.manifest.id
    validateId(id)
    if (this.records.has(id)) throw new PluginError(`Builtin plugin already registered: ${id}`)
    const issues = dependencyIssues(plugin.manifest, this.list())
    if (issues.length) throw new PluginError(`Plugin dependencies are unavailable: ${issues.join('; ')}`)
    const providers: string[] = []
    const protocols: string[] = []
    const ingresses: string[] = []
    const hooks: string[] = []
    const unregister: Array<() => void> = []
    let accepting = true
    let active = true
    let provided: object | undefined
    const assertActive = () => {
      if (!active) throw new PluginError('Plugin is inactive')
    }
    const assertRegistration = () => {
      if (!accepting || !active) throw new PluginError('Plugin registration is closed')
    }
    const registrationId = (name: string) => {
      assertRegistration()
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new PluginError('Invalid registration identifier')
      return `${id}:${name}`
    }
    const storageKey = (key: string) => {
      assertActive()
      validatePath(key)
      if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(key)) throw new PluginError('Invalid plugin storage key')
      return `builtin-plugins:${id}:storage:${key}`
    }
    const api: PluginAPI = {
      // Dashboard contributions belong to installable runtime plugins, not policy built-ins.
      getRecordValues: async () => { assertActive(); throw new PluginError('Builtin dashboard contributions are not supported') },
      getAllRecordValues: async () => { assertActive(); throw new PluginError('Builtin dashboard contributions are not supported') },
      onRecordValuesChange: () => { assertRegistration(); throw new PluginError('Builtin dashboard contributions are not supported') },
      registerMetric: () => { assertRegistration(); throw new PluginError('Builtin dashboard contributions are not supported') },
      config: Object.freeze({}),
      provide: value => {
        assertRegistration()
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginError('Plugin exports must be an object')
        provided = value
      },
      require: <T extends object = Record<string, unknown>>(dependencyId: string): T | undefined => {
        assertActive()
        validateId(dependencyId)
        const required = plugin.manifest.dependencies ?? {}
        const optional = plugin.manifest.optionalDependencies ?? {}
        if (!Object.hasOwn(required, dependencyId) && !Object.hasOwn(optional, dependencyId)) {
          throw new PluginError('Plugin dependency must be declared')
        }
        const range = required[dependencyId] ?? optional[dependencyId]!
        if (dependencyIssues({ ...plugin.manifest, dependencies: { [dependencyId]: range } }, this.list()).length) return undefined
        return this.require(dependencyId) as T | undefined
      },
      registerHook: hook => {
        const name = registrationId(hook.id)
        unregister.push(this.options.hookRegistry.register({ ...hook, id: name }))
        hooks.push(name)
      },
      registerProvider: definition => {
        registrationId(definition.id)
        const name = definition.id
        unregister.push(this.options.providerRegistry.register({ ...definition, id: name }))
        providers.push(name)
      },
      registerProtocol: definition => {
        registrationId(definition.id)
        unregister.push(this.protocolRegistry.register({ ...definition }))
        protocols.push(definition.id)
      },
      registerIngress: definition => {
        registrationId(definition.id)
        unregister.push(this.ingressRegistry.register({ ...definition }))
        ingresses.push(definition.id)
      },
      registerRoute: (method, path, handler) => {
        assertRegistration()
        const key = `${id}:${method.toUpperCase()} ${validatePath(path)}`
        if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method.toUpperCase()) || typeof handler !== 'function') throw new PluginError('Invalid plugin route')
        if (this.routes.has(key)) throw new PluginError('Plugin route already registered')
        this.routes.set(key, handler)
        unregister.push(() => { this.routes.delete(key) })
      },
      onConfigChange: () => { assertRegistration() },
      storage: {
        getItem: key => this.options.storage.getItem(storageKey(key)),
        setItem: (key, value) => this.options.storage.setItem(storageKey(key), value),
        removeItem: key => this.options.storage.removeItem(storageKey(key))
      },
      logger: {
        info: (...values) => console.info(`[builtin:${id}]`, ...values),
        warn: (...values) => console.warn(`[builtin:${id}]`, ...values),
        error: (...values) => console.error(`[builtin:${id}]`, ...values)
      }
    }
    try {
      const setup = plugin.default?.setup ?? plugin.setup
      if (typeof setup !== 'function') throw new PluginError('Plugin setup is required')
      const cleanup = await setup(api)
      if (provided) this.exports.set(id, provided)
      this.disposers.set(id, async () => {
        active = false
        this.exports.delete(id)
        this.records.delete(id)
        const errors: unknown[] = []
        for (const remove of unregister.reverse()) {
          try { remove() }
          catch (error) { errors.push(error) }
        }
        try { if (typeof cleanup === 'function') await cleanup() }
        catch (error) { errors.push(error) }
        if (errors.length) throw new AggregateError(errors, `Builtin plugin cleanup failed: ${id}`)
      })
      this.records.set(id, {
        id, manifest: structuredClone(plugin.manifest), builtin: true,
        enabled: true, status: 'enabled', providers, hooks, protocols, ingresses
      })
    } catch (error) {
      active = false
      provided = undefined
      this.exports.delete(id)
      const errors: unknown[] = [error]
      for (const cleanup of unregister.reverse()) {
        try { cleanup() }
        catch (cleanupError) { errors.push(cleanupError) }
      }
      if (errors.length > 1) throw new AggregateError(errors, 'Builtin setup and rollback failed')
      throw error
    } finally {
      accepting = false
    }
  }

  shutdown(): Promise<void> {
    this.closing = true
    this.shutdownPromise ??= this.dispose()
    return this.shutdownPromise
  }

  private async dispose(): Promise<void> {
    await Promise.allSettled(this.pending.values())
    const errors: unknown[] = []
    for (const dispose of [...this.disposers.values()].reverse()) {
      try { await dispose() }
      catch (error) { errors.push(error) }
    }
    this.disposers.clear()
    this.records.clear()
    this.exports.clear()
    if (errors.length) throw new AggregateError(errors, 'Builtin plugin cleanup failed')
  }

  require(id: string): object | undefined {
    validateId(id)
    return this.exports.get(id)
  }

  list(): PluginRecord[] {
    const records = [...this.records.values()]
    const order = this.options.pluginOrder
    if (order) records.sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id))
    return decorateRecords(structuredClone(records))
  }

  dispatchRoute(id: string, method: string, path: string, event: H3Event): unknown | Promise<unknown> {
    const handler = this.routes.get(`${id}:${method.toUpperCase()} ${validatePath(path)}`)
    if (!handler) throw new PluginError('Plugin route not found')
    return handler(event)
  }
}
