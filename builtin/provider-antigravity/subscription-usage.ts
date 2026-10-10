import type { ProviderConfig } from '../../server/core/types'
import type { SubscriptionUsage, SubscriptionUsageWindow } from '../../server/services/subscription-usage'
import { fetchAntigravityQuota } from './antigravity'
import { optionalPlan, optionalReset, percent } from '../shared/subscription-usage'

export async function fetchAntigravityUsage(config: ProviderConfig, fetcher: typeof fetch): Promise<SubscriptionUsage> {
  const data = await fetchAntigravityQuota(config, fetcher)
  const windows: SubscriptionUsageWindow[] = []
  for (const [model, details] of Object.entries<any>(data?.models || {})) {
    const quota = details?.quotaInfo || details?.quota_info
    const remaining = Number(quota?.remainingFraction ?? quota?.remaining_fraction)
    if (!Number.isFinite(remaining)) continue
    windows.push({
      id: model,
      label: model,
      used_percent: percent((1 - remaining) * 100),
      ...optionalReset(quota?.resetTime || quota?.reset_time)
    })
  }
  return {
    provider: config.name,
    protocol: 'antigravity-subscription',
    ...optionalPlan(config.connection.subscription_type),
    windows,
    fetched_at: new Date().toISOString()
  }
}

