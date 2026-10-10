import { ProviderRegistry } from '../core/registry'
import { OpenAIAdapter } from './openai'
import { OpenAIResponsesAdapter } from './openai-responses'
import { ClaudeAdapter } from './claude'
import { GeminiAdapter } from './gemini'
import { CodexAdapter } from './codex'
import { ClaudeSubscriptionAdapter } from './claude-subscription'
import { AntigravityAdapter } from './antigravity'
import {
  fetchOpenAIModels, fetchClaudeModels, fetchGeminiModels,
  fetchCodexModels, fetchClaudeSubscriptionModels, discoverAntigravityModels
} from './model-discovery'

export const BUILTIN_PROVIDER_IDS = {
  openai: 'openai',
  claude: 'claude',
  gemini: 'gemini',
  codexSubscription: 'codex-subscription',
  claudeSubscription: 'claude-subscription',
  antigravitySubscription: 'antigravity-subscription'
} as const

export type BuiltinProviderId = typeof BUILTIN_PROVIDER_IDS[keyof typeof BUILTIN_PROVIDER_IDS]

export function registerBuiltinProviders(registry: ProviderRegistry): void {
  registry.register({
    id: BUILTIN_PROVIDER_IDS.openai,
    createAdapter: config => config.connection.api_type === 'responses'
      ? new OpenAIResponsesAdapter(config)
      : new OpenAIAdapter(config),
    fetchModels: fetchOpenAIModels,
    secretConnectionFields: []
  })
  registry.register({
    id: BUILTIN_PROVIDER_IDS.claude,
    createAdapter: config => new ClaudeAdapter(config),
    fetchModels: fetchClaudeModels,
    secretConnectionFields: []
  })
  registry.register({
    id: BUILTIN_PROVIDER_IDS.gemini,
    createAdapter: config => new GeminiAdapter(config),
    fetchModels: fetchGeminiModels,
    secretConnectionFields: []
  })
  registry.register({
    id: BUILTIN_PROVIDER_IDS.codexSubscription,
    createAdapter: config => new CodexAdapter(config),
    fetchModels: fetchCodexModels,
    secretConnectionFields: [],
    requiresRefreshToken: true
  })
  registry.register({
    id: BUILTIN_PROVIDER_IDS.claudeSubscription,
    createAdapter: config => new ClaudeSubscriptionAdapter(config),
    fetchModels: fetchClaudeSubscriptionModels,
    secretConnectionFields: [],
    requiresRefreshToken: true
  })
  registry.register({
    id: BUILTIN_PROVIDER_IDS.antigravitySubscription,
    createAdapter: config => new AntigravityAdapter(config),
    fetchModels: discoverAntigravityModels,
    secretConnectionFields: [],
    requiresRefreshToken: true
  })
}

export const providerRegistry = new ProviderRegistry()
registerBuiltinProviders(providerRegistry)
