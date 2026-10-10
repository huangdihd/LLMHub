import type { DashboardHomeContribution } from '~/shared/dashboard/home'

const contributions = import.meta.glob<{ default: DashboardHomeContribution }>('../builtin/*/dashboard-home.ts', { eager: true })

export function useDashboardHome() {
  const entries = Object.values(contributions)
    .map(module => ({ contribution: module.default, session: module.default.create?.() }))
    .sort((left, right) => left.contribution.order - right.contribution.order)

  return {
    contributions: entries.map(({ contribution, session }) => ({
      ...contribution,
      metricProps: () => session?.metricProps?.() || {},
      usageProps: () => session?.usageProps?.() || {}
    })),
    load: async () => { await Promise.all(entries.map(({ session }) => session?.load?.())) },
    commit: () => { entries.forEach(({ session }) => session?.commit?.()) },
    afterLoad: () => { entries.forEach(({ session }) => session?.afterLoad?.()) }
  }
}
