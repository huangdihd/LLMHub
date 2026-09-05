import type { ProviderConfig } from '../core/types'
import { ensureClaudeAccessToken } from './claude-token-manager'
import { ensureCodexAccessToken } from './codex-token-manager'
import { extractChatGptAccountId, extractChatGptPlanType } from '../utils/codex-auth'
import { CLAUDE_CODE_BETA } from '../utils/claude-auth'

const CACHE_TTL_MS = 60 * 1000
const CODEX_API_BASE_URL = 'https://chatgpt.com/backend-api/wham'
const CODEX_USAGE_URL = `${CODEX_API_BASE_URL}/usage`
const CODEX_RESET_CREDITS_URL = `${CODEX_API_BASE_URL}/rate-limit-reset-credits`
const CODEX_CONSUME_RESET_URL = `${CODEX_RESET_CREDITS_URL}/consume`

export interface SubscriptionUsageWindow {
  id: string
  label: string
  used_percent: number
  reset_at?: string
  detail?: string
}

export interface SubscriptionResetCredit {
  id: string
  reset_type: string
  status: string
  granted_at?: string
  expires_at?: string
  title?: string
  description?: string
}

export interface SubscriptionUsage {
  provider: string
  protocol: 'codex-subscription' | 'claude-subscription'
  plan?: string
  windows: SubscriptionUsageWindow[]
  credits?: {
    balance?: number | string
    unlimited?: boolean
    detail?: string
  }
  reset_credits?: {
    available_count: number
    credits?: SubscriptionResetCredit[]
  }
  fetched_at: string
}

const cache = new Map<string, { expiresAt: number; value: SubscriptionUsage }>()

export async function getSubscriptionUsage(
  config: ProviderConfig,
  force = false,
  fetcher: typeof fetch = fetch
): Promise<SubscriptionUsage> {
  if (config.protocol !== 'codex-subscription' && config.protocol !== 'claude-subscription') {
    throw usageError('Subscription usage is only available for subscription providers', 400)
  }

  const cached = cache.get(config.name)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value

  const value = config.protocol === 'codex-subscription'
    ? await fetchCodexUsage(config, fetcher)
    : await fetchClaudeUsage(config, fetcher)
  cache.set(config.name, { expiresAt: Date.now() + CACHE_TTL_MS, value })
  return value
}

export async function consumeCodexResetCredit(
  config: ProviderConfig,
  creditId?: string,
  idempotencyKey = crypto.randomUUID(),
  fetcher: typeof fetch = fetch
): Promise<{ code: string; windows_reset: number }> {
  if (config.protocol !== 'codex-subscription') {
    throw usageError('Usage limit resets are only available for Codex subscription providers', 400)
  }

  const active = await ensureCodexAccessToken(config)
  const accountId = active.connection.account_id
    || extractChatGptAccountId(active.connection.id_token)
    || extractChatGptAccountId(active.connection.api_key)
  if (!accountId) throw usageError('Codex account ID is unavailable; reconnect this provider', 401)

  const response = await fetcher(CODEX_CONSUME_RESET_URL, {
    method: 'POST',
    headers: {
      ...codexHeaders(active.connection.api_key, accountId),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      redeem_request_id: idempotencyKey,
      ...(creditId ? { credit_id: creditId } : {})
    })
  })
  if (!response.ok) throw await responseError(response, 'Unable to use Codex usage limit reset')

  const data = await response.json()
  cache.delete(config.name)
  return {
    code: String(data?.code || 'unknown'),
    windows_reset: Math.max(0, Number(data?.windows_reset) || 0)
  }
}

export function normalizeCodexUsage(
  provider: string,
  data: any,
  configuredPlan?: string,
  resetCreditDetails?: any
): SubscriptionUsage {
  const windows: SubscriptionUsageWindow[] = []
  addCodexWindows(windows, data?.rate_limit ?? data?.rate_limits, '')
  addCodexWindows(windows, data?.code_review_rate_limit, 'Code review ')

  const credits = data?.credits
  const balance = credits?.balance
  const hasBalance = balance !== undefined && balance !== null && balance !== ''
  const creditDetails = credits?.approx_local_messages
    ? `About ${credits.approx_local_messages} local messages`
    : undefined
  const resetCreditSummary = data?.rate_limit_reset_credits
  const availableResetCount = Number(resetCreditDetails?.available_count ?? resetCreditSummary?.available_count)
  const resetCredits = Array.isArray(resetCreditDetails?.credits)
    ? resetCreditDetails.credits
      .filter((credit: any) => String(credit?.status || '').toLowerCase() === 'available')
      .map(normalizeResetCredit)
      .filter((credit: SubscriptionResetCredit | undefined): credit is SubscriptionResetCredit => Boolean(credit))
    : undefined

  return {
    provider,
    protocol: 'codex-subscription',
    ...optionalPlan(data?.plan_type || data?.planType || data?.account?.plan_type || configuredPlan),
    windows,
    ...(credits?.has_credits || credits?.unlimited || hasBalance ? {
      credits: {
        ...(hasBalance ? { balance } : {}),
        ...(credits?.unlimited ? { unlimited: true } : {}),
        ...(creditDetails ? { detail: creditDetails } : {})
      }
    } : {}),
    ...(Number.isFinite(availableResetCount) ? {
      reset_credits: {
        available_count: Math.max(0, Math.trunc(availableResetCount)),
        ...(resetCredits ? { credits: resetCredits } : {})
      }
    } : {}),
    fetched_at: new Date().toISOString()
  }
}

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

async function fetchCodexUsage(config: ProviderConfig, fetcher: typeof fetch): Promise<SubscriptionUsage> {
  const active = await ensureCodexAccessToken(config)
  const accountId = active.connection.account_id
    || extractChatGptAccountId(active.connection.id_token)
    || extractChatGptAccountId(active.connection.api_key)
  if (!accountId) throw usageError('Codex account ID is unavailable; reconnect this provider', 401)

  const headers = codexHeaders(active.connection.api_key, accountId)
  const response = await fetcher(CODEX_USAGE_URL, { headers })
  if (!response.ok) throw await responseError(response, 'Unable to fetch Codex subscription usage')

  const data = await response.json()
  let resetCreditDetails: any
  try {
    const resetResponse = await fetcher(CODEX_RESET_CREDITS_URL, { headers })
    if (resetResponse.ok) resetCreditDetails = await resetResponse.json()
  } catch {
    // Detailed reset rows are optional; retain any count from the usage response.
  }

  const plan = extractChatGptPlanType(active.connection.id_token)
    || extractChatGptPlanType(active.connection.api_key)
  return normalizeCodexUsage(config.name, data, plan, resetCreditDetails)
}

async function fetchClaudeUsage(config: ProviderConfig, fetcher: typeof fetch): Promise<SubscriptionUsage> {
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

function codexHeaders(accessToken: string, accountId: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'ChatGPT-Account-Id': accountId,
    'Accept': 'application/json',
    'Origin': 'https://chatgpt.com',
    'Referer': 'https://chatgpt.com/',
    'User-Agent': 'Mozilla/5.0'
  }
}

function normalizeResetCredit(value: any): SubscriptionResetCredit | undefined {
  const id = typeof value?.id === 'string' ? value.id.trim() : ''
  if (!id) return undefined
  const grantedAt = optionalReset(value.granted_at).reset_at
  const expiresAt = optionalReset(value.expires_at).reset_at
  return {
    id,
    reset_type: String(value.reset_type || 'codex_rate_limits'),
    status: String(value.status || 'available'),
    ...(grantedAt ? { granted_at: grantedAt } : {}),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(typeof value.title === 'string' && value.title.trim() ? { title: value.title.trim() } : {}),
    ...(typeof value.description === 'string' && value.description.trim() ? { description: value.description.trim() } : {})
  }
}

function addCodexWindows(windows: SubscriptionUsageWindow[], rateLimit: any, prefix: string): void {
  if (!rateLimit) return
  const entries: Array<[string, any, number]> = [
    ['primary', rateLimit.primary_window ?? rateLimit.primary ?? rateLimit.five_hour_limit ?? rateLimit.five_hour, 5 * 60 * 60],
    ['secondary', rateLimit.secondary_window ?? rateLimit.secondary ?? rateLimit.weekly_limit ?? rateLimit.weekly, 7 * 24 * 60 * 60]
  ]
  for (const [id, value, fallbackSeconds] of entries) {
    if (!value) continue
    const seconds = positiveNumber(value.limit_window_seconds) || fallbackSeconds
    windows.push({
      id: `${prefix ? 'code-review-' : ''}${id}`,
      label: `${prefix}${windowLabel(seconds)}`.trim(),
      used_percent: codexUsedPercent(value),
      ...optionalReset(value.reset_at ?? value.reset_time_ms, value.reset_after_seconds)
    })
  }
}

function codexUsedPercent(value: any): number {
  if (value?.used_percent !== undefined) return percent(value.used_percent)
  if (value?.percent_left !== undefined) return percent(100 - Number(value.percent_left))
  if (value?.remaining_percent !== undefined) return percent(100 - Number(value.remaining_percent))
  return 0
}

function windowLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}-day`
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour`
  if (seconds % 60 === 0) return `${seconds / 60}-minute`
  return `${seconds}-second`
}

function optionalPlan(value: unknown): { plan?: string } {
  return typeof value === 'string' && value.trim() ? { plan: value.trim() } : {}
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

function optionalReset(value: unknown, afterSeconds?: unknown): { reset_at?: string } {
  let date: Date | undefined
  if (typeof value === 'number' && Number.isFinite(value)) {
    date = new Date(value > 1e11 ? value : value * 1000)
  } else if (typeof value === 'string' && value) {
    date = new Date(value)
  } else {
    const seconds = positiveNumber(afterSeconds)
    if (seconds) date = new Date(Date.now() + seconds * 1000)
  }
  return date && Number.isFinite(date.getTime()) ? { reset_at: date.toISOString() } : {}
}

function percent(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(100, Math.max(0, number))
}

function positiveNumber(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const text = await response.text().catch(() => '')
  let message = fallback
  try {
    const body = JSON.parse(text)
    message = body?.error?.message || body?.message || body?.detail || fallback
  } catch {}
  return usageError(message, response.status >= 400 && response.status < 500 ? response.status : 502)
}

function usageError(message: string, statusCode: number): Error {
  const error: any = new Error(message)
  error.statusCode = statusCode
  return error
}
