import type { Component, Ref } from 'vue'

export interface DashboardProviderRecord {
  name: string
  display_name: string
  protocol: string
  enabled: boolean
  connection: Record<string, any>
  models?: { id: string; display_name: string }[]
  use_custom_models?: boolean
  [field: string]: any
  available?: boolean
  unavailableReason?: string
}

export interface DashboardProviderForm {
  name: string
  display_name: string
  protocol: string
  enabled: boolean
  use_custom_models: boolean
  custom_models: { id: string; display_name: string }[]
  timeout: number
  enable_timeout: boolean
  max_retries: number
  extra: Record<string, unknown>
  [field: string]: any
}

export interface DashboardProviderContext {
  form: DashboardProviderForm
  errors: Record<string, string>
  editingProvider: Ref<DashboardProviderRecord | null>
  isModalOpen: Ref<boolean>
  validateBasics: () => boolean
  loadProviders: () => Promise<unknown>
  showError: (error: unknown, fallback: string) => void
}

export interface DashboardProviderSession {
  state: Record<string, any>
  pending?: () => boolean
  cancel?: () => Promise<void>
  reset?: () => void
  remove?: (name: string) => void
}

/** Components render fragments; the shell owns placement, never provider policy. */
export interface DashboardProviderExtension {
  id: string
  order: number
  label: string
  description: string
  icon: string
  initial?: { display_name: string; name: string; timeout?: number }
  defaults: Record<string, unknown>
  chooseDefaults?: Record<string, unknown>
  sharedPayload?: (form: DashboardProviderForm) => Record<string, unknown>
  emptyDescription?: string
  connectedLabel?: string
  form: Component
  advanced?: Component
  badge?: Component
  actions?: Component
  details?: Component
  edit: (form: DashboardProviderForm, provider: DashboardProviderRecord) => void
  payload: (form: DashboardProviderForm) => Record<string, unknown>
  validate?: (context: DashboardProviderContext) => boolean
  create?: (context: DashboardProviderContext) => DashboardProviderSession
}

/** Policies apply to every provider, including dynamically registered provider types. */
export interface DashboardProviderSection {
  id: string
  order: number
  advanced?: Component
  defaults: Record<string, unknown>
  edit: (form: DashboardProviderForm, provider: DashboardProviderRecord) => void
  payload: (form: DashboardProviderForm) => Record<string, unknown>
}
