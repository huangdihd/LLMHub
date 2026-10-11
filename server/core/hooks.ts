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

export interface PluginResponse {
  response: string | LLMResponse
}

export interface CompletionInfo {
  responseSource?: { pluginId: string; hookId: string }
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
  onRequest?: (request: LLMRequest, context: HookContext) => Awaitable<LLMRequest | PluginResponse | void>
  onResponse?: (response: LLMResponse, context: HookContext) => Awaitable<LLMResponse | void>
  /** undefined preserves the chunk, null or [] drops it. */
  onStreamChunk?: (chunk: LLMStreamChunk, context: HookContext) => Awaitable<LLMStreamChunk | LLMStreamChunk[] | null | void>
}

export class HookRegistry {
  private hooks = new Map<string, RequestHook>()
  private owners = new Map<string, string>()

  register(hook: RequestHook, owner = hook.id): () => void {
    if (!hook.id.trim()) throw new Error('Hook ID must not be empty')
    if (this.hooks.has(hook.id)) throw new Error(`Hook already registered: ${hook.id}`)
    this.hooks.set(hook.id, hook)
    this.owners.set(hook.id, owner)
    return () => {
      if (this.hooks.get(hook.id) !== hook) return
      this.hooks.delete(hook.id)
      this.owners.delete(hook.id)
    }
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

  async request(request: LLMRequest, context: HookContext): Promise<LLMRequest> {
    return (await this.generation(request, context)).request
  }

  async generation(request: LLMRequest, context: HookContext): Promise<{
    request: LLMRequest
    response?: LLMResponse
    responseSource?: CompletionInfo['responseSource']
  }> {
    for (const hook of this.ordered()) {
      const result = await hook.onRequest?.(request, context)
      if (result === undefined) continue
      const invalid = () => new Error(`Plugin ${this.owners.get(hook.id)} hook ${hook.id}: invalid onRequest result`)
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw invalid()
      if ('response' in result) {
        if ('messages' in result || 'config' in result) throw invalid()
        const response = typeof result.response === 'string'
          ? { content: result.response, finishReason: 'stop' as const, usage: { promptTokens: 0, completionTokens: 0 } }
          : result.response
        if (!validResponse(response)) throw invalid()
        return { request, response, responseSource: { pluginId: this.owners.get(hook.id)!, hookId: hook.id } }
      }
      if (!validRequest(result)) throw invalid()
      request = result
    }
    return { request }
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

  private log(hook: RequestHook, point: string, error: unknown) {
    console.error(`[LLMHub] hook ${hook.id} ${point} failed:`, error)
  }
}

type Shape = Record<string, unknown>
type Validator = (value: unknown) => boolean

function record(value: unknown): value is Shape {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const string: Validator = value => typeof value === 'string'
const boolean: Validator = value => typeof value === 'boolean'
const finiteNumber: Validator = value => typeof value === 'number' && Number.isFinite(value)
const oneOf = (...values: unknown[]): Validator => value => values.includes(value)
const optional = (value: unknown, validate: Validator): boolean => value === undefined || validate(value)
function arrayOf(value: unknown, validate: Validator): boolean {
  if (!Array.isArray(value)) return false
  // Iteration visits sparse slots too: holes must not bypass validation.
  for (const entry of value) if (!validate(entry)) return false
  return true
}
function fields(value: Shape, validators: Record<string, Validator>): boolean {
  return Object.entries(validators).every(([key, validate]) => optional(value[key], validate))
}

function jsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || ancestors.has(value)) return false
  ancestors.add(value)
  try {
    // Reject values that JSON.stringify would silently drop or replace.
    if (Array.isArray(value)) return arrayOf(value, entry => jsonValue(entry, ancestors))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return false
    return Object.values(value).every(entry => jsonValue(entry, ancestors))
  } finally {
    ancestors.delete(value)
  }
}

function jsonObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && jsonValue(value)
}

function validTool(value: unknown): boolean {
  return record(value) && string(value.id) && string(value.name) && jsonObject(value.input)
    && optional(value.thoughtSignature, string)
}

function validContent(value: unknown, ancestors = new Set<object>()): boolean {
  if (typeof value === 'string') return true
  if (!Array.isArray(value) || ancestors.has(value)) return false
  ancestors.add(value)
  try {
    return arrayOf(value, block => {
      if (!record(block) || !fields(block, {
        text: string, thinking: string, signature: string, data: string,
        imageUrl: string, imageBase64: string, imageMediaType: string,
        reasoningKind: oneOf('raw', 'summary'), reasoningProvider: oneOf('anthropic', 'openai'),
        toolUse: validTool, toolResult: result => validToolResult(result, ancestors)
      })) return false
      switch (block.type) {
        case 'text': return string(block.text)
        case 'thinking': return string(block.thinking)
        case 'redacted_thinking': return string(block.data)
        case 'tool_use': return block.toolUse !== undefined
        case 'tool_result': return block.toolResult !== undefined
        case 'image': return string(block.imageUrl) || string(block.imageBase64)
        default: return false
      }
    })
  } finally {
    ancestors.delete(value)
  }
}

function validToolResult(value: unknown, ancestors: Set<object>): boolean {
  return record(value) && string(value.toolUseId) && optional(value.isError, boolean)
    && validContent(value.content, ancestors)
}

function validLogprob(value: unknown): boolean {
  return record(value) && string(value.token) && finiteNumber(value.logprob)
    && optional(value.bytes, bytes => bytes === null || arrayOf(bytes, byte =>
      typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255))
}

function validResponse(value: unknown): value is LLMResponse {
  if (!record(value) || !oneOf('stop', 'length', 'tool_calls', 'error')(value.finishReason)) return false
  if (!record(value.usage)) return false
  for (const key of ['promptTokens', 'completionTokens', 'cachedTokens', 'cacheCreationTokens']) {
    const count = value.usage[key]
    if (count === undefined && key !== 'promptTokens' && key !== 'completionTokens') continue
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return false
  }
  return validContent(value.content)
    && optional(value.toolCalls, tools => arrayOf(tools, validTool))
    && optional(value.logprobs, entries => arrayOf(entries, entry => validLogprob(entry)
      && record(entry) && optional(entry.top_logprobs, alternatives => arrayOf(alternatives, validLogprob))))
}

function validMessage(value: unknown): boolean {
  return record(value) && oneOf('user', 'assistant', 'system', 'developer', 'tool')(value.role)
    && validContent(value.content) && optional(value.meta, meta => record(meta) && fields(meta, {
      toolCallId: string, name: string, toolCalls: tools => arrayOf(tools, validTool)
    }))
}

function validOutputFormat(value: unknown): boolean {
  if (!record(value)) return false
  if (value.type === 'text' || value.type === 'json_object') return true
  return value.type === 'json_schema' && record(value.schema) && jsonValue(value.schema)
    && fields(value, { name: string, description: string, strict: strict => strict === null || boolean(strict),
      schemaDialect: oneOf('json_schema', 'gemini') })
}

function validConfig(value: unknown): boolean {
  return record(value) && fields(value, {
    maxTokens: finiteNumber, temperature: finiteNumber, topP: finiteNumber, topLogprobs: finiteNumber,
    stop: stop => arrayOf(stop, string), systemPrompt: string, logprobs: boolean,
    reasoningEffort: string, reasoningSummary: string, outputFormat: validOutputFormat,
    thinkingConfig: thinking => record(thinking) && fields(thinking, {
      thinkingBudget: finiteNumber, includeThoughts: boolean
    }),
    thinking: thinking => record(thinking) && fields(thinking, {
      enabled: boolean, mode: oneOf('enabled', 'adaptive'),
      effort: oneOf('none', 'minimal', 'low', 'medium', 'high', 'xhigh'),
      budgetTokens: finiteNumber, includeSummary: boolean, summary: oneOf('auto', 'concise', 'detailed')
    })
  })
}

function validRequest(value: unknown): value is LLMRequest {
  return record(value) && arrayOf(value.messages, validMessage) && validConfig(value.config)
    && fields(value, {
      model: string, stream: boolean,
      tools: tools => arrayOf(tools, tool => record(tool) && string(tool.name)
        && optional(tool.description, string) && optional(tool.parameters, jsonObject)),
      toolChoice: choice => oneOf('auto', 'none', 'required')(choice) || record(choice) && string(choice.name)
    })
}

export const requestHooks = new HookRegistry()
