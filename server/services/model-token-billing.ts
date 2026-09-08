import type { Usage } from '../core/types'
import type { ModelTokenRatios } from '../stores/model-token-ratios.store'
import { getModelTokenRatios } from '../stores/model-token-ratios.store'

export function calculateBillableTokens(usage: Usage, ratios: ModelTokenRatios): number {
  const promptTokens = Math.max(0, Number(usage.promptTokens) || 0)
  const completionTokens = Math.max(0, Number(usage.completionTokens) || 0)
  const cachedTokens = Math.min(promptTokens, Math.max(0, Number(usage.cachedTokens) || 0))
  const uncachedInputTokens = promptTokens - cachedTokens
  return uncachedInputTokens * ratios.input
    + cachedTokens * ratios.cached
    + completionTokens * ratios.output
}

export async function getBillableTokens(usage: Usage, model?: string): Promise<number> {
  const ratios = await getModelTokenRatios(model)
  return calculateBillableTokens(usage, ratios)
}
