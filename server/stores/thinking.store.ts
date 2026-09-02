import type { ThinkingEffort } from '../core/types'

const STORAGE_KEY = 'settings:thinking'

export interface ThinkingSettings {
  enabled: boolean
  respectClient: boolean
  defaultEffort: ThinkingEffort
  includeSummary: boolean
  budgetMap: Record<ThinkingEffort, number>
  providerOverrides: Record<string, Partial<Pick<ThinkingSettings, 'defaultEffort' | 'includeSummary' | 'budgetMap'>>>
}

export const DEFAULT_THINKING_SETTINGS: ThinkingSettings = {
  enabled: true,
  respectClient: true,
  defaultEffort: 'medium',
  includeSummary: true,
  budgetMap: { none: 0, minimal: 1024, low: 4096, medium: 8192, high: 16384, xhigh: 32768 },
  providerOverrides: {}
}

function cloneDefaults(): ThinkingSettings {
  return JSON.parse(JSON.stringify(DEFAULT_THINKING_SETTINGS))
}

export function validateThinkingSettings(input: any): ThinkingSettings {
  const settings: ThinkingSettings = {
    ...cloneDefaults(),
    ...input,
    budgetMap: { ...DEFAULT_THINKING_SETTINGS.budgetMap, ...(input?.budgetMap || {}) },
    providerOverrides: input?.providerOverrides && typeof input.providerOverrides === 'object' ? input.providerOverrides : {}
  }
  const efforts: ThinkingEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
  if (!efforts.includes(settings.defaultEffort)) throw createError({ statusCode: 400, message: 'Invalid default thinking effort' })
  let previous = -1
  for (const effort of efforts) {
    const value = settings.budgetMap[effort]
    if (!Number.isInteger(value) || value < 0 || value > 1_000_000 || value < previous) {
      throw createError({ statusCode: 400, message: 'Thinking budgets must be increasing integers between 0 and 1000000' })
    }
    previous = value
  }
  return settings
}

export async function getThinkingSettings(): Promise<ThinkingSettings> {
  const stored = await useStorage('data').getItem<ThinkingSettings>(STORAGE_KEY)
  return validateThinkingSettings(stored || DEFAULT_THINKING_SETTINGS)
}

export async function setThinkingSettings(input: any): Promise<ThinkingSettings> {
  const settings = validateThinkingSettings(input)
  await useStorage('data').setItem(STORAGE_KEY, settings)
  return settings
}
