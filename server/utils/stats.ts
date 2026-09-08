import type { H3Event } from 'h3'
import type { Usage } from '../core/types'
import { getAuthStore } from '../stores/auth.store'
import { getBillableTokens } from '../services/model-token-billing'

export const getStats = async () => {
  const storage = useStorage('data')
  const totalCalls = (await storage.getItem('stats:totalCalls')) as number || 0
  return { totalCalls }
}

export const incrementCalls = async () => {
  const storage = useStorage('data')
  const totalCalls = (await storage.getItem('stats:totalCalls')) as number || 0
  await storage.setItem('stats:totalCalls', totalCalls + 1)
}

/**
 * Track API key usage after an LLM call.
 * Pass unified usage when available so per-model billing ratios are applied.
 * Pass a numeric count for embeddings, or 0 when only the call should be counted.
 */
export async function trackUsage(event: H3Event, usage: number | Usage, model?: string): Promise<void> {
  const record = (event as any).context?._apiKeyRecord
  if (!record) return
  try {
    const tokens = typeof usage === 'number' ? usage : await getBillableTokens(usage, model)
    const provider = model?.includes('/') ? model.split('/')[0] : undefined
    await getAuthStore().addUsage(record, tokens, model, provider)
  } catch (e) {
    console.error('[LLMHub] Failed to track usage:', e)
  }
}
