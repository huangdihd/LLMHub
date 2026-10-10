import type { DashboardPage, DashboardRecord, DashboardSectionExtension, DashboardSectionSlot } from '~/shared/dashboard/sections'

const modules = import.meta.glob<{ default: DashboardSectionExtension }>('../builtin/*/dashboard-sections.ts', { eager: true })
const extensions = Object.values(modules).map(module => module.default)
  .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))

export function useDashboardSections(page: DashboardPage) {
  const sessions = extensions.filter(extension => extension.page === page).map(extension => extension.create())
  const sections = sessions.flatMap(session => session.sections)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))

  return {
    sections: (slot: DashboardSectionSlot) => sections.filter(section => section.slot === slot),
    load: () => Promise.all(sessions.map(session => session.load?.())),
    hydrate: (data: DashboardRecord) => { sessions.forEach(session => session.hydrate?.(data)) },
    decorate: (record: DashboardRecord) => sessions.reduce((result, session) => session.decorate?.(result) || result, record),
    payload: () => Object.assign({}, ...sessions.map(session => session.payload?.())) as DashboardRecord
  }
}
