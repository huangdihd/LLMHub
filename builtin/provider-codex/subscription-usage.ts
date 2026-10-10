import type { ProviderConfig } from '../../server/core/types'
import type { SubscriptionUsage, SubscriptionUsageWindow } from '../../server/services/subscription-usage'
import type { SubscriptionResetCredit } from '../../server/services/subscription-usage'
import { usageError } from '../../server/services/subscription-usage'
import { ensureCodexAccessToken } from './codex-token-manager'
import { extractChatGptAccountId, extractChatGptPlanType } from './codex-auth'
import { optionalPlan, optionalReset, percent, positiveNumber, responseError } from '../shared/subscription-usage'

const CODEX_API_BASE_URL = 'https://chatgpt.com/backend-api/wham'
const CODEX_USAGE_URL = `${CODEX_API_BASE_URL}/usage`
const CODEX_RESET_CREDITS_URL = `${CODEX_API_BASE_URL}/rate-limit-reset-credits`
const CODEX_CONSUME_RESET_URL = `${CODEX_RESET_CREDITS_URL}/consume`

export async function consumeCodexResetCredit(
  config: ProviderConfig,
  creditId?: string,
  idempotencyKey: string = crypto.randomUUID(),
  fetcher: typeof fetch = fetch
): Promise<{ code: string; windows_reset: number }> {
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

export async function fetchCodexUsage(config: ProviderConfig, fetcher: typeof fetch): Promise<SubscriptionUsage> {
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

