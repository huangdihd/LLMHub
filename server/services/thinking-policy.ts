import type { LLMRequest, ThinkingEffort, ThinkingRequest } from '../core/types'
import type { ThinkingSettings } from '../stores/thinking.store'
import { getThinkingSettings } from '../stores/thinking.store'

const EFFORTS: ThinkingEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']

function effortForBudget(budget: number, budgetMap: Record<ThinkingEffort, number>): ThinkingEffort {
  let result: ThinkingEffort = 'none'
  for (const effort of EFFORTS) {
    if (budget >= budgetMap[effort]) result = effort
  }
  return result
}

function normalizeEffort(value: unknown): ThinkingEffort | undefined {
  return typeof value === 'string' && EFFORTS.includes(value as ThinkingEffort)
    ? value as ThinkingEffort
    : undefined
}

/**
 * Resolve thinking controls for an upstream request.
 *
 * Requests without any client-supplied thinking parameters are returned
 * unchanged so the upstream model default applies — the gateway must not
 * inject a default effort or budget on its own. Explicit client values are
 * normalized (budget <-> effort via the configurable map); server defaults
 * are only forced when `respectClient` is disabled.
 */
export async function applyThinkingPolicy(
  request: LLMRequest,
  providerName?: string,
  settingsInput?: ThinkingSettings
): Promise<LLMRequest> {
  const settings = settingsInput || await getThinkingSettings()
  if (!settings.enabled) return request

  const override = providerName ? settings.providerOverrides[providerName] : undefined
  const budgetMap = { ...settings.budgetMap, ...(override?.budgetMap || {}) }
  const supplied = request.config.thinking || legacyThinking(request)

  // No client intent: keep the upstream model default instead of injecting one.
  if (!supplied) return request

  // Explicit client opt-out passes through untouched.
  if (supplied.enabled === false) {
    return { ...request, config: { ...request.config, thinking: supplied } }
  }

  if (settings.respectClient) {
    const effort = normalizeEffort(supplied.effort)
      || (supplied.budgetTokens != null ? effortForBudget(supplied.budgetTokens, budgetMap) : undefined)
    const budgetTokens = supplied.budgetTokens ?? (effort != null ? budgetMap[effort] : undefined)
    return { ...request, config: { ...request.config, thinking: { ...supplied, effort, budgetTokens } } }
  }

  const effort = override?.defaultEffort || settings.defaultEffort
  const thinking: ThinkingRequest = {
    ...supplied,
    enabled: supplied.enabled ?? true,
    effort,
    budgetTokens: budgetMap[effort],
    includeSummary: supplied.includeSummary ?? override?.includeSummary ?? settings.includeSummary,
    summary: supplied.summary ?? (settings.includeSummary ? 'auto' : undefined)
  }
  return { ...request, config: { ...request.config, thinking } }
}

function legacyThinking(request: LLMRequest): ThinkingRequest | undefined {
  const budgetTokens = request.config.thinkingConfig?.thinkingBudget
  const effort = normalizeEffort(request.config.reasoningEffort)
  if (budgetTokens == null && !effort && !request.config.reasoningSummary) return undefined
  return {
    enabled: budgetTokens !== 0,
    budgetTokens,
    effort,
    includeSummary: request.config.thinkingConfig?.includeThoughts,
    summary: request.config.reasoningSummary as ThinkingRequest['summary']
  }
}
