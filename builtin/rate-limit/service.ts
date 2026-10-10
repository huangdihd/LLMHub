import type { BruteForceConfig } from '../../server/stores/auth.store'

export async function checkRateLimit(ip: string, cfg: BruteForceConfig): Promise<{ allowed: boolean; retryAfter?: number }> {
  if (!cfg.rate_limit_enabled || cfg.rate_limit_max_rpm <= 0) {
    return { allowed: true }
  }

  const key = `auth:rl:${ip}`
  const windowStart = Date.now() - 60 * 1000
  const entry = await useStorage('data').getItem<{ count: number; windowStart: number }>(key)

  if (!entry || entry.windowStart < windowStart) {
    await useStorage('data').setItem(key, { count: 1, windowStart: Date.now() })
    return { allowed: true }
  }

  if (entry.count >= cfg.rate_limit_max_rpm) {
    const retryAfter = Math.ceil((entry.windowStart + 60 * 1000 - Date.now()) / 1000)
    return { allowed: false, retryAfter }
  }

  entry.count++
  await useStorage('data').setItem(key, entry)
  return { allowed: true }
}
