import type { Component } from 'vue'

export interface ApiKeyDashboardRecord {
  id: string
  name: string
  created_at: string
  [field: string]: unknown
}

export type ApiKeyDashboardSlot = 'badge' | 'summary' | 'meter' | 'details' | 'editor'

export interface ApiKeyDashboardSection {
  id: string
  slot: ApiKeyDashboardSlot
  order: number
  component: Component
  props: (record?: ApiKeyDashboardRecord) => Record<string, unknown>
}

/** Per-page capabilities allow extensions to share data without shell-owned policy state. */
export interface ApiKeyDashboardContext {
  set<T>(key: symbol, value: T): void
  get<T>(key: symbol): T
}

export interface ApiKeyDashboardSession {
  sections: ApiKeyDashboardSection[]
  load?: () => Promise<void>
  reset?: (record?: ApiKeyDashboardRecord) => void
  payload?: () => Record<string, unknown>
}

export interface ApiKeyDashboardExtension {
  id: string
  order: number
  create: (context: ApiKeyDashboardContext) => ApiKeyDashboardSession
}
