import type { ProviderConfig } from '../../server/core/types'
import type { SubscriptionUsage, SubscriptionUsageWindow } from '../../server/services/subscription-usage'
import { ensureClaudeAccessToken } from './claude-token-manager'
import { CLAUDE_CODE_BETA } from './claude-auth'
import { optionalPlan, optionalReset, percent, responseError } from '../shared/subscription-usage'

export function normalizeClaudeUsage(provider: string, data: any, configuredPlan?: string): SubscriptionUsage {
  const windows: SubscriptionUsageWindow[] = []
  const seen = new Set<string>()
  const knownWindows: Array<[string, string, string]> = [
    ['five_hour', '5-hour', '5h'],
    ['seven_day', '7-day', '7d'],
    ['seven_day_sonnet', '7-day Sonnet', '7d-sonnet'],
    ['seven_day_omelette', '7-day Opus', '7d-opus'],
    ['seven_day_opus', '7-day Opus', '7d-opus-legacy']
  ]
  for (const [key, label, id] of knownWindows) {
    const value = data?.[key]
    if (!value || value.utilization === undefined || value.utilization === null) continue
    windows.push({
      id,
      label,
      used_percent: percent(value.utilization),
      ...optionalReset(value.resets_at)
    })
    seen.add(key === 'five_hour' ? 'session' : key === 'seven_day' ? 'weekly_all' : id)
  }

  for (const limit of Array.isArray(data?.limits) ? data.limits : []) {
    const kind = String(limit?.kind || '')
    if ((kind === 'session' || kind === 'weekly_all') && seen.has(kind)) continue
    if (kind !== 'session' && kind !== 'weekly_all' && kind !== 'weekly_scoped') continue
    const model = limit?.scope?.model?.display_name || limit?.scope?.model?.name
    const id = kind === 'weekly_scoped' ? `scoped-${String(model || windows.length)}` : kind
    windows.push({
      id,
      label: kind === 'session' ? '5-hour' : kind === 'weekly_all' ? '7-day' : `7-day ${model || 'model'}`,
      used_percent: percent(limit.percent ?? limit.utilization),
      ...optionalReset(limit.resets_at),
      ...(limit.severity ? { detail: String(limit.severity) } : {})
    })
  }

  const extra = data?.extra_usage
  if (extra?.is_enabled && Number(extra.monthly_limit) > 0) {
    const currency = String(extra.currency || 'USD')
    const used = Number(extra.used_credits || 0) / 100
    const limit = Number(extra.monthly_limit) / 100
    windows.push({
      id: 'extra-usage',
      label: 'Extra usage',
      used_percent: percent(extra.utilization ?? (limit > 0 ? used / limit * 100 : 0)),
      detail: `${currency} ${used.toFixed(2)} of ${limit.toFixed(2)}`
    })
  }

  return {
    provider,
    protocol: 'claude-subscription',
    ...optionalPlan(configuredPlan || data?.subscription_type || data?.subscriptionType || data?.plan),
    windows,
    fetched_at: new Date().toISOString()
  }
}

export async function fetchClaudeUsage(config: ProviderConfig, fetcher: typeof fetch): Promise<SubscriptionUsage> {
  const active = await ensureClaudeAccessToken(config)
  const response = await fetcher(`${active.connection.base_url.replace(/\/$/, '')}/api/oauth/usage`, {
    headers: {
      'Authorization': `Bearer ${active.connection.api_key}`,
      'anthropic-beta': CLAUDE_CODE_BETA.includes('oauth-2025-04-20') ? 'oauth-2025-04-20' : CLAUDE_CODE_BETA,
      'Accept': 'application/json',
      'User-Agent': 'claude-code/2.1.220'
    }
  })
  if (!response.ok) throw await responseError(response, 'Unable to fetch Claude subscription usage')
  const plan = active.connection.subscription_type
    || planFromRateLimitTier(active.connection.rate_limit_tier)
  return normalizeClaudeUsage(config.name, await response.json(), plan)
}

function planFromRateLimitTier(value?: string): string | undefined {
  if (!value) return undefined
  const normalized = value.toLowerCase()
  if (normalized.includes('max')) return 'max'
  if (normalized.includes('pro')) return 'pro'
  if (normalized.includes('team')) return 'team'
  if (normalized.includes('enterprise')) return 'enterprise'
  return undefined
}

