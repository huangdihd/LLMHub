import type { H3Event } from 'h3'
import type { HookRegistry } from '../server/core/hooks'
import type { ProviderRegistry } from '../server/core/registry'
import { ProtocolRegistry } from '../server/core/protocol-registry'
import { IngressRegistry } from '../server/core/ingress-registry'
import type { PluginAPI, PluginStorage } from '../server/plugins-runtime/manager'
import { PluginError, validateId, validatePath } from '../server/plugins-runtime/manifest'
import type { PluginRecord } from '../shared/types/plugin'
import type { BuiltinPlugin } from './catalog'

export interface BuiltinHostOptions {
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
    const id = plugin.manifest.id
    validateId(id)
    if (this.records.has(id) || this.pending.has(id)) throw new PluginError(`Builtin plugin already registered: ${id}`)
    // Defer setup until the pending reservation exists, including for reentrant setup.
    const operation = Promise.resolve().then(() => this.setup(plugin))
    this.pending.set(id, operation)
    try { await operation }
    finally { this.pending.delete(id) }
  }

  private async setup(plugin: BuiltinPlugin): Promise<void> {
    const id = plugin.manifest.id
    validateId(id)
    if (this.records.has(id)) throw new PluginError(`Builtin plugin already registered: ${id}`)
    const providers: string[] = []
    const protocols: string[] = []
    const ingresses: string[] = []
    const hooks: string[] = []
    const unregister: Array<() => void> = []
    let accepting = true
    const assertRegistration = () => {
      if (!accepting) throw new PluginError('Plugin registration is closed')
    }
    const registrationId = (name: string) => {
      assertRegistration()
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new PluginError('Invalid registration identifier')
      return `${id}:${name}`
    }
    const storageKey = (key: string) => {
      validatePath(key)
      if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(key)) throw new PluginError('Invalid plugin storage key')
      return `builtin-plugins:${id}:storage:${key}`
    }
    const api: PluginAPI = {
      config: Object.freeze({}),
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
      this.disposers.set(id, async () => {
        for (const remove of unregister.reverse()) remove()
        if (typeof cleanup === 'function') await cleanup()
      })
      this.records.set(id, {
        id, manifest: structuredClone(plugin.manifest), builtin: true,
        enabled: true, status: 'enabled', providers, hooks, protocols, ingresses
      })
    } catch (error) {
      for (const cleanup of unregister.reverse()) cleanup()
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
    if (errors.length) throw new AggregateError(errors, 'Builtin plugin cleanup failed')
  }

  list(): PluginRecord[] {
    return structuredClone([...this.records.values()])
  }

  dispatchRoute(id: string, method: string, path: string, event: H3Event): unknown | Promise<unknown> {
    const handler = this.routes.get(`${id}:${method.toUpperCase()} ${validatePath(path)}`)
    if (!handler) throw new PluginError('Plugin route not found')
    return handler(event)
  }
}
