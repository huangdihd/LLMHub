import type { ProviderConfig } from '../core/types'
import { providerRegistry } from '../core/registry'

const CACHE_TTL_MS = 60 * 1000

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
  protocol: string
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

export interface SubscriptionResetResult {
  code: string
  windows_reset: number
}

const cache = new Map<string, { expiresAt: number; value: SubscriptionUsage }>()

export function supportsSubscriptionUsage(protocol: ProviderConfig['protocol']): boolean {
  return Boolean(providerRegistry.get(protocol)?.subscriptionUsage)
}

export function supportsSubscriptionReset(protocol: ProviderConfig['protocol']): boolean {
  return Boolean(providerRegistry.get(protocol)?.resetSubscriptionUsage)
}

export async function getSubscriptionUsage(
  config: ProviderConfig,
  force = false,
  fetcher: typeof fetch = fetch
): Promise<SubscriptionUsage> {
  const subscriptionUsage = providerRegistry.get(config.protocol)?.subscriptionUsage
  if (!subscriptionUsage) {
    throw usageError('Subscription usage is only available for subscription providers', 400)
  }

  const cached = cache.get(config.name)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value

  const value = await subscriptionUsage(config, fetcher)
  cache.set(config.name, { expiresAt: Date.now() + CACHE_TTL_MS, value })
  return value
}

export async function consumeSubscriptionResetCredit(
  config: ProviderConfig,
  creditId?: string,
  idempotencyKey: string = crypto.randomUUID(),
  fetcher: typeof fetch = fetch
): Promise<SubscriptionResetResult> {
  const resetSubscriptionUsage = providerRegistry.get(config.protocol)?.resetSubscriptionUsage
  if (!resetSubscriptionUsage) {
    throw usageError(providerRegistry.subscriptionResetErrors.unsupportedOperation, 400)
  }

  const result = await resetSubscriptionUsage(config, creditId, idempotencyKey, fetcher)
  cache.delete(config.name)
  return result
}

export function usageError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode })
}
