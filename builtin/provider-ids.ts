/** Persisted identifiers: changing these would require a provider-data migration. */
export const BUILTIN_PROVIDER_IDS = {
  openai: 'openai',
  claude: 'claude',
  gemini: 'gemini',
  codexSubscription: 'codex-subscription',
  claudeSubscription: 'claude-subscription',
  antigravitySubscription: 'antigravity-subscription'
} as const

export type BuiltinProviderId = typeof BUILTIN_PROVIDER_IDS[keyof typeof BUILTIN_PROVIDER_IDS]
