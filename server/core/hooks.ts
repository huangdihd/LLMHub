import type { H3Event } from 'h3'
import type { LLMRequest, LLMResponse, LLMStreamChunk, ModelInfo, ProviderConfig, Usage } from './types'
import type { ApiKeyRecord } from '../stores/auth.store'

type Awaitable<T> = T | Promise<T>

export interface HookContext {
  incomingProtocol: string
  providerName?: string
  providerConfig?: ProviderConfig
  apiKeyRecord?: ApiKeyRecord
}

export interface AdmissionRejection {
  status: number
  message: string
  code: string
}

export interface AdmissionContext {
  event: H3Event
  incomingProtocol: string
  apiKeyRecord?: ApiKeyRecord
  model: string
}

export type AdmissionStage = 'onBeforeIdentity' | 'onAfterIdentity' | 'onModelResolved'

export interface CompletionInfo {
  model?: string
  usage?: Usage
  error?: unknown
}

export interface RequestHook {
  id: string
  /** Lower priorities run first; equal priorities retain registration order. */
  priority?: number
  onBeforeIdentity?: (context: AdmissionContext) => Awaitable<AdmissionRejection | void>
  onAfterIdentity?: (context: AdmissionContext) => Awaitable<AdmissionRejection | void>
  onModelResolved?: (context: AdmissionContext) => Awaitable<AdmissionRejection | void>
  onModels?: (models: ModelInfo[], context: HookContext) => Awaitable<ModelInfo[] | void>
  onModelsRefreshed?: (validModelIds: ReadonlySet<string>) => Awaitable<void>
  onRequest?: (request: LLMRequest, context: HookContext) => Awaitable<LLMRequest | void>
  onResponse?: (response: LLMResponse, context: HookContext) => Awaitable<LLMResponse | void>
  /** undefined preserves the chunk, null or [] drops it. */
  onStreamChunk?: (chunk: LLMStreamChunk, context: HookContext) => Awaitable<LLMStreamChunk | LLMStreamChunk[] | null | void>
  onError?: (error: unknown, context: HookContext) => Awaitable<void>
  onComplete?: (completion: CompletionInfo, context: HookContext) => Awaitable<void>
}

export class HookRegistry {
  private hooks = new Map<string, RequestHook>()

  register(hook: RequestHook): () => void {
    if (!hook.id.trim()) throw new Error('Hook ID must not be empty')
    if (this.hooks.has(hook.id)) throw new Error(`Hook already registered: ${hook.id}`)
    this.hooks.set(hook.id, hook)
    return () => { if (this.hooks.get(hook.id) === hook) this.hooks.delete(hook.id) }
  }

  private ordered(): RequestHook[] {
    return [...this.hooks.values()].sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0))
  }

  async admission(stage: AdmissionStage, context: AdmissionContext): Promise<AdmissionRejection | undefined> {
    for (const hook of this.ordered()) {
      const rejection = await hook[stage]?.(context)
      if (rejection) return rejection
    }
  }

  async models(models: ModelInfo[], context: HookContext): Promise<ModelInfo[]> {
    for (const hook of this.ordered()) {
      const result = await hook.onModels?.(models, context)
      if (result) models = result
    }
    return models
  }

  async modelsRefreshed(validModelIds: ReadonlySet<string>): Promise<void> {
    for (const hook of this.ordered()) {
      await hook.onModelsRefreshed?.(validModelIds)
    }
  }

  async request(request: LLMRequest, context: HookContext): Promise<LLMRequest> {
    for (const hook of this.ordered()) {
      const result = await hook.onRequest?.(request, context)
      if (result) request = result
    }
    return request
  }

  async response(response: LLMResponse, context: HookContext): Promise<LLMResponse> {
    for (const hook of this.ordered()) {
      try {
        const result = await hook.onResponse?.(response, context)
        if (result) response = result
      } catch (error) {
        this.log(hook, 'onResponse', error)
      }
    }
    return response
  }

  async streamChunk(chunk: LLMStreamChunk, context: HookContext): Promise<LLMStreamChunk[]> {
    let chunks = [chunk]
    for (const hook of this.ordered()) {
      if (!hook.onStreamChunk) continue
      const next: LLMStreamChunk[] = []
      for (const current of chunks) {
        try {
          const result = await hook.onStreamChunk(current, context)
          if (result === null) continue
          next.push(...(Array.isArray(result) ? result : [result || current]))
        } catch (error) {
          this.log(hook, 'onStreamChunk', error)
          next.push(current)
        }
      }
      chunks = next
    }
    return chunks
  }

  async error(error: unknown, context: HookContext): Promise<void> {
    for (const hook of this.ordered()) {
      try { await hook.onError?.(error, context) }
      catch (hookError) { this.log(hook, 'onError', hookError) }
    }
  }

  async complete(completion: CompletionInfo, context: HookContext): Promise<void> {
    for (const hook of this.ordered()) {
      try { await hook.onComplete?.(completion, context) }
      catch (error) { this.log(hook, 'onComplete', error) }
    }
  }

  private log(hook: RequestHook, point: string, error: unknown) {
    console.error(`[LLMHub] hook ${hook.id} ${point} failed:`, error)
  }
}

export const requestHooks = new HookRegistry()
