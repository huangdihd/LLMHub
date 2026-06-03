import type { ProviderConfig } from '../core/types'

export interface FetchOptions extends RequestInit {
  timeout?: number
  enable_timeout?: boolean
  maxRetries?: number
  retryDelay?: number
}

/**
 * Robust fetch with timeout and exponential backoff retry.
 */
export async function fetchWithRetry(
  url: string,
  options: FetchOptions = {},
  config?: ProviderConfig['connection']
): Promise<Response> {
  const timeout = options.timeout ?? config?.timeout ?? 30000
  const enableTimeout = options.enable_timeout ?? config?.enable_timeout ?? true
  const maxRetries = options.maxRetries ?? config?.max_retries ?? 3
  const retryDelay = options.retryDelay ?? 1000

  let lastError: any
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    let timeoutId: any

    if (enableTimeout) {
      timeoutId = setTimeout(() => controller.abort(), timeout)
    }

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      })

      if (timeoutId) clearTimeout(timeoutId)

      // Retry on 5xx errors or 429 (Rate Limit)
      if (attempt < maxRetries && (response.status >= 500 || response.status === 429)) {
        console.warn(`[LLMHub] Fetch attempt ${attempt + 1} failed with status ${response.status}. Retrying in ${retryDelay * Math.pow(2, attempt)}ms...`)
        await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt)))
        continue
      }

      return response
    } catch (err: any) {
      if (timeoutId) clearTimeout(timeoutId)
      
      lastError = err

      // Don't retry if aborted by user (not by our timeout)
      if (err.name === 'AbortError' && !enableTimeout) {
        throw err
      }

      if (attempt < maxRetries) {
        const isTimeout = err.name === 'AbortError' || err.message?.includes('timeout')
        console.warn(`[LLMHub] Fetch attempt ${attempt + 1} failed (${isTimeout ? 'Timeout' : err.message}). Retrying...`)
        await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt)))
        continue
      }
    }
  }

  throw lastError
}
