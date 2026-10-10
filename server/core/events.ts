import type { CompletionInfo, HookContext } from './hooks'

export interface SystemEventMap {
  'llmhub:request-complete': { completion: CompletionInfo; context: HookContext }
  'llmhub:request-error': { error: unknown; context: HookContext }
  'llmhub:models-refreshed': { validModelIds: readonly string[] }
}

export type EventPayload<Name extends string> = Name extends keyof SystemEventMap ? SystemEventMap[Name] : Record<string, unknown>
export type EventListener<Payload = Record<string, unknown>> = (payload: Payload) => void | Promise<void>

interface Subscription {
  owner: string
  name: string
  listener: EventListener
  priority: number
}

/** Errors retain identity for pipeline deduplication; freeze their data before sharing. */
function freezeError(value: object, seen = new Set<object>()): void {
  if (seen.has(value)) return
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const item = Object.getOwnPropertyDescriptor(value, key)?.value
    if (item && typeof item === 'object') freezeError(item, seen)
  }
  Object.freeze(value)
}

/** Isolate ordinary data while preserving the pipeline's error identity contract. */
function clonePayload<T>(value: T, seen = new Map<object, unknown>()): T {
  if (typeof value === 'function' || typeof value === 'symbol') throw new Error('Event payload must contain data only')
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return seen.get(value) as T
  if (value instanceof Error) {
    freezeError(value)
    return value
  }
  if (value instanceof Date) return new Date(value.getTime()) as T
  if (value instanceof Set) {
    const copy = new Set<unknown>()
    seen.set(value, copy)
    for (const item of value) copy.add(clonePayload(item, seen))
    return copy as T
  }
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>()
    seen.set(value, copy)
    for (const [key, item] of value) copy.set(clonePayload(key, seen), clonePayload(item, seen))
    return copy as T
  }
  let copy: object
  if (Array.isArray(value)) copy = []
  else copy = {}
  seen.set(value, copy)
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, { value: clonePayload((value as Record<string, unknown>)[key], seen), writable: true, enumerable: true, configurable: true })
  }
  return copy as T
}

/** Notifications are ordered, isolated observations, never pipeline transformations. */
export class EventRegistry {
  private readonly subscriptions = new Set<Subscription>()

  constructor(private readonly timeoutMs = 5000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid event listener timeout')
  }

  subscribe<Name extends string>(owner: string, name: Name, listener: EventListener<EventPayload<Name>>, priority = 0): () => void {
    if (!owner.trim() || !/^[a-z0-9][a-z0-9-]{1,40}:[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('Invalid event subscription')
    if (typeof listener !== 'function' || !Number.isFinite(priority)) throw new Error('Invalid event listener')
    const subscription: Subscription = { owner, name, listener: listener as EventListener, priority }
    this.subscriptions.add(subscription)
    return () => { this.subscriptions.delete(subscription) }
  }

  async emit<Name extends string>(name: Name, payload: EventPayload<Name>): Promise<void> {
    const subscriptions = [...this.subscriptions].filter(subscription => subscription.name === name)
      .sort((left, right) => left.priority - right.priority)
    // Snapshot before yielding: publishers cannot mutate later listeners' input mid-delivery.
    let snapshot: Record<string, unknown>
    try { snapshot = clonePayload(payload) }
    catch (error) {
      console.error(`[LLMHub] Event payload could not be cloned (${name}):`, error)
      return
    }
    for (const subscription of subscriptions) {
      if (!this.subscriptions.has(subscription)) continue
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const copy = clonePayload(snapshot)
        await Promise.race([
          Promise.resolve().then(() => {
            if (this.subscriptions.has(subscription)) return subscription.listener(copy)
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Event listener timed out')), this.timeoutMs)
          })
        ])
      } catch (error) {
        console.error(`[LLMHub] Event listener failed (${subscription.owner}, ${name}):`, error)
      } finally { clearTimeout(timer) }
    }
  }
}

export const systemEvents = new EventRegistry()
