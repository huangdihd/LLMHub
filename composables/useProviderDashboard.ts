import type { DashboardProviderContext, DashboardProviderExtension, DashboardProviderSection, DashboardProviderRecord } from '~/shared/dashboard/providers'

const modules = import.meta.glob<{ default: DashboardProviderExtension }>('../builtin/*/dashboard-provider.ts', { eager: true })
const extensions = Object.values(modules).map(module => module.default)
  .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))

const sectionModules = import.meta.glob<{ default: DashboardProviderSection }>('../builtin/*/dashboard-provider-section.ts', { eager: true })
const sections = Object.values(sectionModules).map(module => module.default)
  .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))

export function useProviderDashboard(context: DashboardProviderContext) {
  const sessions = new Map(extensions.map(extension => [extension.id, extension.create?.(context)]))
  return {
    extensions,
    sections,
    defaults: Object.assign({}, ...extensions.map(extension => extension.defaults), ...sections.map(section => section.defaults)),
    extension: (protocol: string) => extensions.find(extension => extension.id === protocol),
    edit: (provider: DashboardProviderRecord) => {
      // Legacy connection fields are restored even for other provider protocols.
      extensions.forEach(extension => extension.edit(context.form, provider))
      sections.forEach(section => section.edit(context.form, provider))
    },
    payload: () => Object.assign({},
      ...extensions.map(extension => extension.sharedPayload?.(context.form)),
      extensions.find(extension => extension.id === context.form.protocol)?.payload(context.form),
      ...sections.map(section => section.payload(context.form))),
    state: (protocol: string) => sessions.get(protocol)?.state || {},
    pending: () => sessions.get(context.form.protocol)?.pending?.() || false,
    cancel: async () => { await sessions.get(context.form.protocol)?.cancel?.() },
    reset: () => { sessions.forEach(session => session?.reset?.()) },
    remove: (name: string) => { sessions.forEach(session => session?.remove?.(name)) }
  }
}
