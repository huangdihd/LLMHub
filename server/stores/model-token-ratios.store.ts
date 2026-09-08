const STORAGE_KEY = 'settings:model-token-ratios'

export interface ModelTokenRatios {
  input: number
  output: number
  cached: number
}

export interface ModelTokenRatioSettings {
  ratios: Record<string, ModelTokenRatios>
}

export const DEFAULT_MODEL_TOKEN_RATIOS: ModelTokenRatios = {
  input: 1,
  output: 1,
  cached: 1
}

function validateRatio(value: unknown): number {
  const ratio = Number(value)
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 100) {
    throw createError({ statusCode: 400, message: 'Token billing ratios must be numbers between 0 and 100' })
  }
  return ratio
}

export function validateModelTokenRatioSettings(input: any): ModelTokenRatioSettings {
  const source = input?.ratios
  if (source == null) return { ratios: {} }
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw createError({ statusCode: 400, message: 'Model token ratios must be an object' })
  }

  const ratios: Record<string, ModelTokenRatios> = {}
  for (const [model, value] of Object.entries(source)) {
    if (!model.trim() || typeof value !== 'object' || value == null || Array.isArray(value)) {
      throw createError({ statusCode: 400, message: 'Each model must have valid token billing ratios' })
    }
    const candidate = value as Partial<ModelTokenRatios>
    const modelRatios = {
      input: validateRatio(candidate.input ?? 1),
      output: validateRatio(candidate.output ?? 1),
      cached: validateRatio(candidate.cached ?? 1)
    }
    if (Object.values(modelRatios).some(ratio => ratio !== 1)) ratios[model] = modelRatios
  }
  return { ratios }
}

export async function getModelTokenRatioSettings(): Promise<ModelTokenRatioSettings> {
  const stored = await useStorage('data').getItem<ModelTokenRatioSettings>(STORAGE_KEY)
  return validateModelTokenRatioSettings(stored)
}

export async function setModelTokenRatioSettings(input: any): Promise<ModelTokenRatioSettings> {
  const settings = validateModelTokenRatioSettings(input)
  await useStorage('data').setItem(STORAGE_KEY, settings)
  return settings
}

export async function getModelTokenRatios(model?: string): Promise<ModelTokenRatios> {
  if (!model) return { ...DEFAULT_MODEL_TOKEN_RATIOS }
  const settings = await getModelTokenRatioSettings()
  return settings.ratios[model] || { ...DEFAULT_MODEL_TOKEN_RATIOS }
}
