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
  entry?: string
  configSchema?: PluginField[]
  ui?: { page: string }
}

export interface PluginRecord {
  id: string
  manifest: PluginManifest
  enabled: boolean
  status: 'installed' | 'disabled' | 'enabled' | 'error'
  error?: string
  providers: string[]
  hooks: string[]
}
