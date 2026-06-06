import type { H3Event } from 'h3'
import { getAuthStore } from '../stores/auth.store'

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
 * Call from non-streaming handlers with actual token counts.
 * Call from streaming handlers with tokens=0 to just count the call.
 */
export async function trackUsage(event: H3Event, tokens: number, model?: string): Promise<void> {
  const record = (event as any).context?._apiKeyRecord
  if (!record) return
  try {
    const provider = model?.includes('/') ? model.split('/')[0] : undefined
    await getAuthStore().addUsage(record, tokens, model, provider)
  } catch (e) {
    console.error('[LLMHub] Failed to track usage:', e)
  }
}
