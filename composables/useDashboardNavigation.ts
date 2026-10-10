import type { DashboardNavigationItem } from '~/shared/dashboard/navigation'

const contributions = import.meta.glob<{ default: DashboardNavigationItem[] }>('../builtin/*/dashboard-navigation.ts', { eager: true })

export function useDashboardNavigation() {
  return [
    { label: 'Home', to: '/', order: 0 },
    { label: 'Models', to: '/models', order: 10 },
    { label: 'API Keys', to: '/api-keys', order: 20 },
    { label: 'Providers', to: '/providers', order: 30 },
    { label: 'Plugins', to: '/plugins', order: 40 },
    { label: 'Security', to: '/security', order: 50 },
    ...Object.values(contributions).flatMap(module => module.default)
  ].sort((left, right) => left.order - right.order)
}
