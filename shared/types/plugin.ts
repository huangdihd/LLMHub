export interface PluginField {
  key: string
  label?: string
  type: 'text' | 'secret' | 'number' | 'boolean' | 'select'
  required?: boolean
  default?: string | number | boolean
  options?: { label: string; value: string | number | boolean }[]
}

export interface PluginManifest {
  id: string
  name?: string
  version: string
  description?: string
  engines?: { llmhub?: string }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  entry?: string
  configSchema?: PluginField[]
  ui?: { page: string }
}

export interface PluginDependencyStatus {
  id: string
  range: string
  optional: boolean
  satisfied: boolean
  version?: string
  reason?: string
}

export interface PluginRecord {
  warnings?: string[]
  dependencies?: PluginDependencyStatus[]
  requiredBy?: string[]
  /** Built-in application plugins are always enabled and read-only. */
  builtin?: boolean
  id: string
  manifest: PluginManifest
  enabled: boolean
  status: 'installed' | 'disabled' | 'enabled' | 'error'
  error?: string
  providers: string[]
  hooks: string[]
  protocols?: string[]
  ingresses?: string[]
}
