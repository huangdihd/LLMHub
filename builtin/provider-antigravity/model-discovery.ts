import type { ProviderConfig, ModelInfo } from '../../server/core/types'
import { fetchWithRetry } from '../../server/utils/fetch'
import { fetchAntigravityModels } from './antigravity'

const MODEL_DISCOVERY_TIMEOUT = 10_000
const MODEL_DISCOVERY_MAX_RETRIES = 1
const MODEL_DISCOVERY_FETCH_OPTIONS = {
  timeout: MODEL_DISCOVERY_TIMEOUT,
  enable_timeout: true,
  maxRetries: MODEL_DISCOVERY_MAX_RETRIES
} as const

export async function discoverAntigravityModels(config: ProviderConfig): Promise<ModelInfo[]> {
  const fetcher = (url: string | URL | Request, init?: RequestInit) => fetchWithRetry(String(url), {
    ...init,
    ...MODEL_DISCOVERY_FETCH_OPTIONS
  }, config.connection)
  return (await fetchAntigravityModels(config, fetcher)).map(model => ({
    id: `${config.name}/${model.id}`,
    provider: config.name,
    name: model.id,
    display_name: model.display_name,
    capabilities: model.capabilities
  }))
}
