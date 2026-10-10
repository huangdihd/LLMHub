import type { Component } from 'vue'

export type DashboardPage = 'models' | 'security'
export type DashboardSectionSlot = 'description' | 'model-actions' | 'login-settings' | 'after-login'
export type DashboardRecord = Record<string, any>

export interface DashboardSection {
  id: string
  slot: DashboardSectionSlot
  order: number
  component: Component
  props: (record?: DashboardRecord) => Record<string, unknown>
}

/** A session owns extension state for one mounted page, never a module singleton. */
export interface DashboardSectionSession {
  sections: DashboardSection[]
  load?: () => Promise<void>
  hydrate?: (data: DashboardRecord) => void
  decorate?: (record: DashboardRecord) => DashboardRecord
  payload?: () => DashboardRecord
}

export interface DashboardSectionExtension {
  id: string
  page: DashboardPage
  order: number
  create: () => DashboardSectionSession
}
