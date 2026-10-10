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

/** Gateway metadata inside package.json; npm dependencies remain separate. */
export interface PluginPackageMetadata {
  id?: string
  name?: string
  configSchema?: PluginField[]
  ui?: { page: string }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

export type PluginPackageExport = string | null | { [condition: string]: PluginPackageExport }

export interface PluginPackageManifest {
  name: string
  version: string
  description?: string
  type?: 'module' | 'commonjs'
  main?: string
  exports?: PluginPackageExport
  engines?: { llmhub?: string; [engine: string]: string | undefined }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  keywords?: string[]
  llmhub: PluginPackageMetadata
}

export interface PluginDependencyStatus {
  id: string
  range: string
  optional: boolean
  satisfied: boolean
  version?: string
  reason?: string
}

export type PluginSource = {
  [Type in 'builtin' | 'npm' | 'github' | 'directory' | 'upload']: {
    type: Type
    packageName?: string
    specification?: string
    direct?: boolean
    owner?: string
    repo?: string
    ref?: string
    commit?: string
    range?: string
  }
}['builtin' | 'npm' | 'github' | 'directory' | 'upload']

export interface PluginRecord {
  capabilities?: { update: boolean; uninstall: boolean }
  source?: PluginSource
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
