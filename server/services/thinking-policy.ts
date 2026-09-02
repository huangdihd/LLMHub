import type { LLMRequest, ThinkingEffort, ThinkingRequest } from '../core/types'
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

/** Apply persisted defaults and derive both effort and token budget for an upstream request. */
export async function applyThinkingPolicy(request: LLMRequest, providerName?: string): Promise<LLMRequest> {
  const settings = await getThinkingSettings()
  const override = providerName ? settings.providerOverrides[providerName] : undefined
  const budgetMap = { ...settings.budgetMap, ...(override?.budgetMap || {}) }
  const supplied = request.config.thinking || legacyThinking(request)

  if (!settings.enabled && !supplied) return request
  if (settings.respectClient && supplied?.enabled === false) return request

  const effort = normalizeEffort(supplied?.effort)
    || (supplied?.budgetTokens != null ? effortForBudget(supplied.budgetTokens, budgetMap) : undefined)
    || override?.defaultEffort
    || settings.defaultEffort
  const budgetTokens = supplied?.budgetTokens ?? budgetMap[effort]
  const thinking: ThinkingRequest = {
    enabled: supplied?.enabled ?? settings.enabled,
    mode: supplied?.mode,
    effort,
    budgetTokens,
    includeSummary: supplied?.includeSummary ?? override?.includeSummary ?? settings.includeSummary,
    summary: supplied?.summary ?? (settings.includeSummary ? 'auto' : undefined)
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
