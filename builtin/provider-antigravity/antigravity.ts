import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { ModelConfig, ProviderConfig } from '../../server/core/types'
import { ensureAntigravityAccessToken } from './antigravity-token-manager'
import {
  ANTIGRAVITY_API_BASE_URL,
  ANTIGRAVITY_PRODUCTION_API_BASE_URL,
  ANTIGRAVITY_USER_AGENT,
  antigravityControlRequest
} from './antigravity-auth'
import { fetchWithRetry } from '../../server/utils/fetch'
import { GeminiAdapter } from '../provider-gemini/gemini'

export const DEFAULT_ANTIGRAVITY_MODELS: ModelConfig[] = [
  { id: 'gemini-3-flash', display_name: 'Gemini 3 Flash', capabilities: { vision: true, tools: true, streaming: true } },
  { id: 'gemini-pro-agent', display_name: 'Gemini Pro Agent', capabilities: { vision: true, tools: true, streaming: true } },
  { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', capabilities: { vision: true, tools: true, streaming: true } },
  { id: 'claude-opus-4-6-thinking', display_name: 'Claude Opus 4.6 Thinking', capabilities: { vision: true, tools: true, streaming: true } }
]

export class AntigravityAdapter extends GeminiAdapter {
  override name = 'antigravity'

  override async call(input: any): Promise<any> {
    const { modelId: model, payload } = input
    const config = await ensureAntigravityAccessToken(this.config)
    const request = wrapAntigravityRequest(model, payload, config.connection.project_id!)
    const baseUrl = config.connection.base_url || ANTIGRAVITY_API_BASE_URL

    const body = await this.fetchJson(config, baseUrl, request)
    if (!body?.response) throw new Error('Antigravity returned an invalid response')
    return body.response
  }

  override callStream(input: any): ReadableStream<Uint8Array> {
    const { modelId: model, payload } = input
    const self = this
    return new ReadableStream({
      async start(controller) {
        try {
          const config = await ensureAntigravityAccessToken(self.config)
          const baseUrl = config.connection.base_url || ANTIGRAVITY_API_BASE_URL
          const response = await self.fetchStream(
            config,
            baseUrl,
            wrapAntigravityRequest(model, payload, config.connection.project_id!)
          )
          await pipeUnwrappedSse(
            response,
            controller,
            config.connection.enable_timeout === false ? 0 : config.connection.timeout ?? 120000
          )
        } catch (error) {
          controller.error(error)
        }
      }
    })
  }

  private async fetchJson(config: ProviderConfig, baseUrl: string, request: any): Promise<any> {
    let lastError: unknown
    let aiCreditsAttempted = false
    for (const candidate of antigravityBaseUrls(baseUrl)) {
      try {
        const url = `${candidate}/v1internal:generateContent`
        const options = {
          method: 'POST',
          headers: antigravityHeaders(config.connection.api_key),
          body: JSON.stringify(request)
        }
        let response = await fetchWithRetry(url, { ...options, retryOnRateLimit: false }, config.connection)
        if (response.ok) return response.json()

        let error = await antigravityApiError(response)
        if (shouldRetryWithAiCredits(config, error) && !aiCreditsAttempted) {
          aiCreditsAttempted = true
          response = await fetchWithRetry(url, {
            ...options,
            body: JSON.stringify(withAiCredits(request)),
            maxRetries: 0
          }, config.connection)
          if (response.ok) return response.json()
          error = await antigravityApiError(response)
        }
        if (response.status !== 429 && response.status < 500) throw error
        lastError = error
      } catch (error: any) {
        if (error?._statusCode && error._statusCode < 500 && error._statusCode !== 429) throw error
        lastError = error
      }
    }
    throw lastError || new Error('All Antigravity endpoints failed')
  }

  private async fetchStream(config: ProviderConfig, baseUrl: string, request: any): Promise<Response> {
    let lastError: unknown
    let aiCreditsAttempted = false
    for (const candidate of antigravityBaseUrls(baseUrl)) {
      try {
        const url = `${candidate}/v1internal:streamGenerateContent?$alt=sse`
        let response = await fetchAntigravityStream(url, config, request)
        if (response.ok && response.body) return response

        let error = await antigravityApiError(response)
        if (shouldRetryWithAiCredits(config, error) && !aiCreditsAttempted) {
          aiCreditsAttempted = true
          response = await fetchAntigravityStream(url, config, withAiCredits(request))
          if (response.ok && response.body) return response
          error = await antigravityApiError(response)
        }
        if (response.status !== 429 && response.status < 500) throw error
        lastError = error
      } catch (error: any) {
        if (error?._statusCode && error._statusCode < 500 && error._statusCode !== 429) throw error
        lastError = error
      }
    }
    throw lastError || new Error('All Antigravity endpoints failed')
  }
}

async function fetchAntigravityStream(
  url: string,
  config: ProviderConfig,
  request: any
): Promise<Response> {
  const abortController = new AbortController()
  const timeout = config.connection.enable_timeout === false
    ? undefined
    : setTimeout(() => abortController.abort(), config.connection.timeout ?? 120000)
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { ...antigravityHeaders(config.connection.api_key), 'Accept': 'text/event-stream' },
      body: JSON.stringify(request),
      signal: abortController.signal
    })
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function shouldRetryWithAiCredits(config: ProviderConfig, error: any): boolean {
  return config.connection.use_ai_credits_on_quota_exhausted === true
    && error?._statusCode === 429
    && error?._quotaExhausted === true
}

function withAiCredits(request: any): any {
  return { ...request, enabledCreditTypes: ['GOOGLE_ONE_AI'] }
}

export async function fetchAntigravityModels(
  config: ProviderConfig,
  fetcher: typeof fetch = fetch
): Promise<ModelConfig[]> {
  const ready = await ensureAntigravityAccessToken(config)
  const body = await fetchAntigravityControlWithFallback(ready, 'fetchAvailableModels', fetcher)
  if (!body?.models || typeof body.models !== 'object') return DEFAULT_ANTIGRAVITY_MODELS
  return Object.entries<any>(body.models).map(([id, details]) => ({
    id,
    display_name: details?.displayName || antigravityModelDisplayName(id),
    capabilities: { vision: true, tools: true, streaming: true }
  }))
}

export async function fetchAntigravityQuota(config: ProviderConfig, fetcher: typeof fetch = fetch): Promise<any> {
  const ready = await ensureAntigravityAccessToken(config)
  return fetchAntigravityControlWithFallback(ready, 'fetchAvailableModels', fetcher)
}

async function fetchAntigravityControlWithFallback(
  config: ProviderConfig,
  method: string,
  fetcher: typeof fetch = fetch
): Promise<any> {
  let lastError: unknown
  const configured = config.connection.base_url || ANTIGRAVITY_API_BASE_URL
  for (const baseUrl of antigravityBaseUrls(configured)) {
    try {
      return await antigravityControlRequest(
        baseUrl,
        method,
        { project: config.connection.project_id },
        config.connection.api_key,
        fetcher
      )
    } catch (error: any) {
      if (error?.statusCode && error.statusCode < 500 && error.statusCode !== 429) throw error
      lastError = error
    }
  }
  throw lastError || new Error('All Antigravity endpoints failed')
}

function wrapAntigravityRequest(model: string, payload: any, project: string): any {
  const request = JSON.parse(JSON.stringify(payload || {}))
  delete request.safetySettings
  request.sessionId ||= stableSessionId(request)
  return {
    project,
    model,
    userAgent: 'antigravity',
    requestType: 'agent',
    requestId: `agent-${randomUUID()}`,
    request
  }
}

function stableSessionId(request: any): string {
  let seed = ''
  for (const content of request?.contents || []) {
    if (content?.role !== 'user') continue
    seed = (content.parts || [])
      .filter((part: any) => typeof part?.text === 'string')
      .map((part: any) => part.text)
      .join('\n')
    if (seed) break
  }
  if (!seed) return `-${randomBytes(8).readBigUInt64BE().toString()}`
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 8)
  bytes[0] &= 0x7f
  const id = bytes.readBigUInt64BE()
  return `-${(id || BigInt(1)).toString()}`
}

function antigravityBaseUrls(configured: string): string[] {
  const primary = configured.replace(/\/$/, '')
  return primary === ANTIGRAVITY_API_BASE_URL
    ? [primary, ANTIGRAVITY_PRODUCTION_API_BASE_URL]
    : [primary]
}

function antigravityHeaders(accessToken: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': ANTIGRAVITY_USER_AGENT
  }
}

async function pipeUnwrappedSse(
  response: Response,
  controller: ReadableStreamDefaultController<Uint8Array>,
  idleTimeoutMs: number
): Promise<void> {
  const encoder = new TextEncoder()
  let sawContent = false
  let sawFinishReason = false
  for await (const data of readAntigravityStream(response, idleTimeoutMs)) {
    if (data === '[DONE]') continue
    try {
      const body = JSON.parse(data)
      const envelopes = Array.isArray(body) ? body : [body]
      for (const envelope of envelopes) {
        const chunk = envelope?.response
        if (!chunk) continue
        const candidate = chunk.candidates?.[0]
        if (candidate?.content?.parts?.length) sawContent = true
        if (candidate?.finishReason) sawFinishReason = true
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }
    } catch {
      // Ignore malformed upstream frames instead of emitting invalid Gemini SSE.
    }
  }
  if (sawContent && !sawFinishReason) {
    controller.enqueue(encoder.encode('data: {"candidates":[{"finishReason":"STOP"}]}\n\n'))
  }
  controller.close()
}

async function* readAntigravityStream(response: Response, idleTimeoutMs: number): AsyncGenerator<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await readStreamChunk(reader, idleTimeoutMs)
    if (done) {
      buffer += decoder.decode()
      break
    }
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() || ''
    for (const frame of frames) {
      const data = sseFrameData(frame)
      if (data) yield data
    }
  }
  const finalData = sseFrameData(buffer)
  if (finalData) {
    yield finalData
  } else if (buffer.trim()) {
    // Some upstream proxies return a JSON envelope (or array) with HTTP 200.
    yield buffer.trim()
  }
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!(idleTimeoutMs > 0)) return reader.read()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Antigravity stream was idle for ${idleTimeoutMs}ms`)
          void reader.cancel(error).catch(() => {})
          reject(error)
        }, idleTimeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function sseFrameData(frame: string): string {
  return frame.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
}

function antigravityModelDisplayName(id: string): string {
  return id.split('-').map(word => word ? word[0].toUpperCase() + word.slice(1) : word).join(' ')
}

async function antigravityApiError(response: Response): Promise<Error> {
  const text = await response.text().catch(() => '')
  let message = `Antigravity API request failed (${response.status})`
  try {
    const body = JSON.parse(text)
    message = body.error?.message || body.message || message
  } catch {}
  const error: any = new Error(message)
  error.statusCode = response.status
  error._statusCode = response.status
  error._providerError = true
  error._errorBody = { message, type: 'api_error', code: bodyCode(text) }
  error._quotaExhausted = /quota[_ ]exhausted/i.test(text)
  return error
}

function bodyCode(text: string): string | undefined {
  try { return JSON.parse(text)?.error?.status }
  catch { return undefined }
}
