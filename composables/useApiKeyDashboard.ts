import type { ApiKeyDashboardContext, ApiKeyDashboardExtension, ApiKeyDashboardRecord, ApiKeyDashboardSlot } from '~/shared/dashboard/api-keys'

const modules = import.meta.glob<{ default: ApiKeyDashboardExtension }>('../builtin/*/dashboard-api-key.ts', { eager: true })
const extensions = Object.values(modules).map(module => module.default)
  .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))

export function useApiKeyDashboard() {
  const capabilities = new Map<symbol, unknown>()
  const context: ApiKeyDashboardContext = {
    set: (key, value) => { capabilities.set(key, value) },
    get<T>(key: symbol): T {
      if (!capabilities.has(key)) throw new Error(`Missing API key dashboard capability: ${String(key)}`)
      return capabilities.get(key) as T
    }
  }
  const sessions = extensions.map(extension => extension.create(context))
  const sections = sessions.flatMap(session => session.sections)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))

  return {
    sections: (slot: ApiKeyDashboardSlot) => sections.filter(section => section.slot === slot),
    load: () => Promise.all(sessions.map(session => session.load?.())),
    reset: (record?: ApiKeyDashboardRecord) => { sessions.forEach(session => session.reset?.(record)) },
    payload: () => Object.assign({}, ...sessions.map(session => session.payload?.())) as Record<string, unknown>
  }
}
