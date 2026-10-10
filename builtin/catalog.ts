import providerOpenai from './provider-openai/plugin'
import providerClaude from './provider-claude/plugin'
import providerGemini from './provider-gemini/plugin'
import providerCodex from './provider-codex/plugin'
import providerClaudeSubscription from './provider-claude-subscription/plugin'
import providerAntigravity from './provider-antigravity/plugin'
import accessControl from './access-control/plugin'
import cchNormalization from './cch-normalization/plugin'
import fallback from './fallback/plugin'
import quota from './quota/plugin'
import rateLimit from './rate-limit/plugin'
import stats from './stats/plugin'
import thinkingPolicy from './thinking-policy/plugin'
import tokenBilling from './token-billing/plugin'
import type { PluginModule } from '../server/plugins-runtime/manager'
import type { PluginManifest } from '../shared/types/plugin'

export interface BuiltinPlugin extends PluginModule {
  manifest: PluginManifest
  layer: string
}

function entry(id: string, name: string, plugin: Pick<BuiltinPlugin, 'setup'>): BuiltinPlugin {
  return { manifest: { id, name, version: '1.0.0' }, layer: `./builtin/${id}`, setup: plugin.setup }
}

/** Server registration list; Nuxt discovers layer configurations without loading this module. */
export const builtinCatalog: readonly BuiltinPlugin[] = [
  entry('provider-openai', 'OpenAI provider', providerOpenai),
  entry('provider-claude', 'Claude provider', providerClaude),
  entry('provider-gemini', 'Gemini provider', providerGemini),
  entry('provider-codex', 'Codex subscription provider', providerCodex),
  entry('provider-claude-subscription', 'Claude subscription provider', providerClaudeSubscription),
  entry('provider-antigravity', 'Antigravity subscription provider', providerAntigravity),
  entry('rate-limit', 'Rate limiting', rateLimit),
  entry('fallback', 'Fallback routing', fallback),
  entry('access-control', 'Model access control', accessControl),
  entry('quota', 'Usage quotas', quota),
  entry('stats', 'Request statistics', stats),
  entry('token-billing', 'Token billing', tokenBilling),
  entry('thinking-policy', 'Thinking policy', thinkingPolicy),
  entry('cch-normalization', 'CCH normalization', cchNormalization)
]
