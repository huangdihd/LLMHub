import { usageError } from '../../server/services/subscription-usage'

export function optionalPlan(value: unknown): { plan?: string } {
  return typeof value === 'string' && value.trim() ? { plan: value.trim() } : {}
}

export function optionalReset(value: unknown, afterSeconds?: unknown): { reset_at?: string } {
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

export function percent(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(100, Math.max(0, number))
}

export function positiveNumber(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

export async function responseError(response: Response, fallback: string): Promise<Error> {
  const text = await response.text().catch(() => '')
  let message = fallback
  try {
    const body = JSON.parse(text)
    message = body?.error?.message || body?.message || body?.detail || fallback
  } catch {}
  return usageError(message, response.status >= 400 && response.status < 500 ? response.status : 502)
}

