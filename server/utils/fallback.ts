import type { ApiKeyRecord } from '../stores/auth.store'

export interface FallbackResult {
  resolved: string | null
  exhausted: boolean
}

/**
 * Resolve a fallback model from the key's priority list.
 * Skips models that:
 *  - have exceeded their per-model quota
 *  - belong to a provider with an exceeded per-provider quota
 *  - have exceeded the key's global monthly limit
 */
export function resolveFallbackModel(record: ApiKeyRecord): FallbackResult {
  const strategy = record.fallback_strategy
  if (!strategy || !strategy.enabled || strategy.priority.length === 0) {
    return { resolved: null, exhausted: false }
  }

  // Global quota exhausted – no model can be used
  if (record.monthly_limit > 0 && record.tokens_used >= record.monthly_limit) {
    return { resolved: null, exhausted: true }
  }

  for (const modelId of strategy.priority) {
    // Check model quota
    const modelQuota = record.model_quotas?.[modelId] || 0
    if (modelQuota > 0) {
      const modelUsed = record.model_usage?.[modelId] || 0
      if (modelUsed >= modelQuota) continue
    }

    // Check provider quota
    const provider = modelId.includes('/') ? modelId.split('/')[0] : ''
    if (provider) {
      const providerQuota = record.provider_quotas?.[provider] || 0
      if (providerQuota > 0) {
        const providerUsed = record.provider_usage?.[provider] || 0
        if (providerUsed >= providerQuota) continue
      }
    }

    return { resolved: modelId, exhausted: false }
  }

  return { resolved: null, exhausted: true }
}
