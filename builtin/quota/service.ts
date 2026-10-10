import type { H3Event } from 'h3'
import type { Usage } from '../../server/core/types'
import type { ApiKeyRecord, ApiKeyPublic } from '../../server/stores/auth.store'
import { readApiKeys, writeApiKeys, monthKey } from '../../server/stores/api-key-storage'
import { getBillableTokens } from '../token-billing/service'

// All quota mutations rewrite the same array, so lock the whole transaction,
// not individual reads/writes (including updates for different API keys).
let pendingMutation: Promise<unknown> = Promise.resolve()
function withQuotaMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingMutation.then(operation)
  pendingMutation = result.catch(() => {})
  return result
}

export function listKeys(): Promise<ApiKeyPublic[]> {
  return withQuotaMutation(readAndResetKeys)
}

async function readAndResetKeys(): Promise<ApiKeyPublic[]> {
  const keys = await readApiKeys()
  // Auto-reset monthly counters if month changed
  const month = monthKey()
  let changed = false
  for (const k of keys) {
    if (k.current_month !== month) {
      k.tokens_used = 0
      k.model_usage = k.model_usage ? {} : {}
      k.provider_usage = k.provider_usage ? {} : {}
      k.current_month = month
      changed = true
    }
  }
  if (changed) await writeApiKeys(keys)

  return keys.map(k => ({
    id: k.id,
    name: k.name,
    allowed_providers: k.allowed_providers,
    allowed_models: k.allowed_models,
    monthly_limit: k.monthly_limit,
    tokens_used: k.tokens_used,
    call_count: k.call_count,
    created_at: k.created_at,
    model_quotas: k.model_quotas || {},
    model_usage: k.model_usage || {},
    provider_quotas: k.provider_quotas || {},
    provider_usage: k.provider_usage || {},
    fallback_strategy: k.fallback_strategy || { enabled: false, name: 'auto', priority: [] }
  }))
}

/** Increment usage for a key record. Must pass the record (already looked up). */
export function addUsage(record: ApiKeyRecord, tokens: number, model?: string, provider?: string): Promise<void> {
  return withQuotaMutation(() => persistUsage(record, tokens, model, provider))
}

async function persistUsage(record: ApiKeyRecord, tokens: number, model?: string, provider?: string): Promise<void> {
  const keys = await readApiKeys()
  const target = keys.find(k => k.id === record.id)
  if (!target) return

  const month = monthKey()
  if (target.current_month !== month) {
    target.tokens_used = 0
    target.model_usage = target.model_usage ? {} : {}
    target.provider_usage = target.provider_usage ? {} : {}
    target.current_month = month
  }
  target.tokens_used += tokens
  target.call_count += 1

  if (model) {
    if (!target.model_usage) target.model_usage = {}
    target.model_usage[model] = (target.model_usage[model] || 0) + tokens
  }
  if (provider) {
    if (!target.provider_usage) target.provider_usage = {}
    target.provider_usage[provider] = (target.provider_usage[provider] || 0) + tokens
  }

  await writeApiKeys(keys)
}

/** Remove stale model references from all keys after provider model list changes. */
export function cleanupStaleModels(validModelIds: ReadonlySet<string>): Promise<void> {
  return withQuotaMutation(() => persistModelCleanup(validModelIds))
}

async function persistModelCleanup(validModelIds: ReadonlySet<string>): Promise<void> {
  const keys = await readApiKeys()
  let changed = false
  for (const k of keys) {
    // Clean up allowed_models
    if (k.allowed_models?.length > 0) {
      const before = k.allowed_models.length
      k.allowed_models = k.allowed_models.filter(m => validModelIds.has(m))
      if (k.allowed_models.length !== before) changed = true
    }
    // Clean up model_quotas
    if (k.model_quotas) {
      for (const m of Object.keys(k.model_quotas)) {
        if (!validModelIds.has(m)) {
          delete k.model_quotas[m]
          changed = true
        }
      }
    }
    // Clean up model_usage
    if (k.model_usage) {
      for (const m of Object.keys(k.model_usage)) {
        if (!validModelIds.has(m)) {
          delete k.model_usage[m]
          changed = true
        }
      }
    }
  }
  if (changed) await writeApiKeys(keys)
}

/**
 * Track API key usage after an LLM call.
 * Pass unified usage when available so per-model billing ratios are applied.
 * Numeric counts remain supported for legacy callers; new completions use unified Usage.
 */
export async function trackUsage(event: H3Event, usage: number | Usage, model?: string): Promise<void> {
  const record = (event as any).context?._apiKeyRecord
  if (!record) return
  try {
    const tokens = typeof usage === 'number' ? usage : await getBillableTokens(usage, model)
    const provider = model?.includes('/') ? model.split('/')[0] : undefined
    await addUsage(record, tokens, model, provider)
  } catch (e) {
    console.error('[LLMHub] Failed to track usage:', e)
  }
}
