import type { Component } from 'vue'

export interface DashboardHomeSession {
  metricProps?: () => Record<string, unknown>
  usageProps?: () => Record<string, unknown>
  load?: () => Promise<void>
  // Commit only after the shell and all contributions finish their initial requests.
  commit?: () => void
  afterLoad?: () => void
}

export interface DashboardHomeContribution {
  order: number
  endpoint?: Component
  action?: Component
  metric?: Component
  usage?: Component
  create?: () => DashboardHomeSession
}
