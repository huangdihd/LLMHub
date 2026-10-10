/**
 * Copy this file alongside a plugin for author-time types; it never imports
 * gateway source files or h3. Only standard Node and DOM types are required.
 * Keep synchronized with tests/plugin-api.type-test.ts, not runtime imports.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Supported public subset of the runtime H3Event, not a replica of its class.
 * Internal state, deprecated aliases and framework-specific context extensions
 * are intentionally excluded. Helpers requiring the full h3 class still need
 * that package's types; this portable interface does not promise compatibility.
 */
export interface H3Event {
  node: {
    req: IncomingMessage & { originalUrl?: string }
    res: ServerResponse
  }
  context: Record<string, unknown> & {
    params?: Record<string, string>
    clientAddress?: string
  }
  readonly method: 'GET' | 'HEAD' | 'PATCH' | 'POST' | 'PUT' | 'DELETE' | 'CONNECT' | 'OPTIONS' | 'TRACE'
  readonly path: string
  readonly headers: Headers
  readonly handled: boolean
  respondWith(response: Response | PromiseLike<Response>): Promise<void>
}

export interface PluginField {
  key: string
  label?: string
  type: 'text' | 'secret' | 'number' | 'boolean' | 'select'
  required?: boolean
  default?: string | number | boolean
  options?: { label: string; value: string | number | boolean }[]
}

export interface PluginManifest {
  id: string
  name?: string
  version: string
  description?: string
  engines?: { llmhub?: string }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  entry?: string
  configSchema?: PluginField[]
  ui?: { page: string }
}

/** Gateway metadata inside package.json; npm dependencies remain separate. */
export interface PluginPackageMetadata {
  id?: string
  name?: string
  configSchema?: PluginField[]
  ui?: { page: string }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

export type PluginPackageExport = string | null | { [condition: string]: PluginPackageExport }

export interface PluginPackageManifest {
  name: string
  version: string
  description?: string
  type?: 'module' | 'commonjs'
  main?: string
  exports?: PluginPackageExport
  engines?: { llmhub?: string; [engine: string]: string | undefined }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  keywords?: string[]
  llmhub: PluginPackageMetadata
}

export interface PluginDependencyStatus {
  id: string
  range: string
  optional: boolean
  satisfied: boolean
  version?: string
  reason?: string
}

export interface PluginStorage {
  getItem<T>(key: string): Promise<T | null>
  setItem<T>(key: string, value: T): Promise<unknown>
  removeItem(key: string): Promise<unknown>
  getKeys?(prefix: string): Promise<string[]>
}
type Cleanup = () => void | Promise<void>
type RouteHandler = (event: H3Event) => unknown | Promise<unknown>
export interface PluginAPI {
  readonly config: Readonly<Record<string, unknown>>
  provide(value: object): void
  require<T extends object = Record<string, unknown>>(pluginId: string): T | undefined
  registerProvider(definition: ProviderDefinition): void
  registerProtocol(definition: ProtocolDefinition): void
  registerIngress(definition: IngressDefinition): void
  registerHook(hook: RequestHook): void
  registerRoute(method: string, path: string, handler: RouteHandler): void
  onConfigChange(listener: (configuration: Readonly<Record<string, unknown>>) => void | Promise<void>): void
  storage: PluginStorage
  logger: Pick<Console, 'info' | 'warn' | 'error'>
}
export interface PluginModule {
  default?: { setup(api: PluginAPI): void | Cleanup | Promise<void | Cleanup> }
  setup?: (api: PluginAPI) => void | Cleanup | Promise<void | Cleanup>
}

// ============ 统一请求 ============
export interface LLMRequest {
  model?: string
  messages: Message[]
  config: GenerateConfig
  tools?: Tool[]
  toolChoice?: ToolChoice
  stream?: boolean
}

// ============ 消息 ============
export interface Message {
  role: 'user' | 'assistant' | 'system' | 'developer' | 'tool'
  content: Content
  meta?: MessageMeta
}

export type Content = string | ContentBlock[]

export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result' | 'thinking' | 'redacted_thinking'
  text?: string
  thinking?: string
  /** Visible reasoning channel; absent preserves legacy summary serialization. */
  reasoningKind?: 'raw' | 'summary'
  /** Anthropic signature for a visible thinking block. */
  signature?: string
  /** Anthropic redacted-thinking payload or OpenAI/Codex encrypted reasoning state. */
  data?: string
  /** The upstream that produced opaque reasoning data. It prevents unsafe cross-provider reuse. */
  reasoningProvider?: 'anthropic' | 'openai'
  imageUrl?: string
  imageBase64?: string
  imageMediaType?: string
  toolUse?: ToolUse
  toolResult?: ToolResult
}

export interface ToolUse {
  id: string
  name: string
  input: object
}

export interface ToolResult {
  toolUseId: string
  content: Content
  isError?: boolean
}

export interface MessageMeta {
  toolCalls?: ToolCall[]
  toolCallId?: string
  name?: string
}

// ============ 工具定义 ============
export interface Tool {
  name: string
  description: string
  parameters: object
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string }

// ============ 生成配置 ============
export type ThinkingEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface ThinkingRequest {
  enabled?: boolean
  mode?: 'enabled' | 'adaptive'
  effort?: ThinkingEffort
  budgetTokens?: number
  includeSummary?: boolean
  summary?: 'auto' | 'concise' | 'detailed'
}

export type OutputFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; schema: Record<string, any>; name?: string; description?: string; strict?: boolean | null; schemaDialect?: 'json_schema' | 'gemini' }

export interface GenerateConfig {
  /** Requested output contract; capability enforcement remains upstream. */
  outputFormat?: OutputFormat
  maxTokens?: number
  temperature?: number
  topP?: number
  stop?: string[]
  systemPrompt?: string
  /** 是否返回 token logprobs（OpenAI chat: logprobs=true） */
  logprobs?: boolean
  /** 每个 token 返回的候选数（OpenAI: top_logprobs，隐含 logprobs=true） */
  topLogprobs?: number
  thinkingConfig?: {
    thinkingBudget?: number
    includeThoughts?: boolean
  }
  /** Normalized, protocol-independent thinking controls. */
  thinking?: ThinkingRequest
  /** Legacy fields retained while adapters migrate to `thinking`. */
  reasoningEffort?: string
  reasoningSummary?: string
}

/**
 * 单个输出 token 的 logprob 信息，形状与 OpenAI 一致
 * （chat completions 的 `logprobs.content[i]` / responses 的 output_text logprobs）。
 */
export interface TokenLogprob {
  token: string
  logprob: number
  bytes?: number[] | null
  top_logprobs?: Array<{ token: string; logprob: number; bytes?: number[] | null }>
}

// ============ 统一响应 ============
export interface LLMResponse {
  content: Content
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error'
  toolCalls?: ToolCall[]
  usage: Usage
  /** 输出文本各 token 的 logprobs（客户端请求 logprobs 时才有） */
  logprobs?: TokenLogprob[]
}

export interface ToolCall {
  id: string
  name: string
  input: object
  thoughtSignature?: string
}

export interface Usage {
  /** Total input tokens, including cache reads and cache creation. */
  promptTokens: number
  completionTokens: number
  /** Input tokens read from a provider-side prompt/context cache. */
  cachedTokens?: number
  /** Input tokens used to create a provider-side cache entry. */
  cacheCreationTokens?: number
}

// ============ 统一嵌入请求 ============
export interface EmbeddingRequest {
  model?: string
  /** 归一化后的待嵌入输入，每个元素为一段文本或 token 序列 */
  input: Array<string | number[]>
  /** 输出维度（OpenAI: dimensions / Gemini: outputDimensionality） */
  dimensions?: number
  /** 客户端期望的编码格式，仅 OpenAI 协议出口使用 */
  encodingFormat?: 'float' | 'base64'
  /** Gemini 透传字段 */
  taskType?: string
  title?: string
}

// ============ 统一嵌入响应 ============
export interface EmbeddingResponse {
  embeddings: number[][]
  model?: string
  usage: {
    promptTokens: number
    totalTokens: number
  }
}

// ============ 流式响应 ============
export interface LLMStreamChunk {
  type: 'content' | 'thinking' | 'opaque_reasoning' | 'tool_call' | 'done' | 'error'
  delta?: string
  /** Visible reasoning channel; independent of opaque/encrypted reasoning state. */
  reasoningKind?: 'raw' | 'summary'
  toolCall?: ToolCallDelta
  finishReason?: string
  usage?: Usage
  /** 本帧 content 对应的 token logprobs（仅 type==='content' 时可能存在） */
  logprobs?: TokenLogprob[]
  /** Anthropic signature delta attached to the active thinking block. */
  signature?: string
  /** Opaque Anthropic redacted-thinking data. */
  opaqueData?: string
  reasoningProvider?: 'anthropic' | 'openai'
  /** Opaque Responses reasoning state used to continue stateless Codex turns. */
  encryptedContent?: string
}

export interface ToolCallDelta {
  index?: number
  id?: string
  name?: string
  inputDelta?: string
  thoughtSignature?: string
}

// ============ Provider 配置 ============
export interface ProviderConfig {
  name: string
  display_name: string
  protocol: string
  enabled: boolean
  use_custom_models: boolean
  normalize_cch?: boolean
  connection: {
    api_key: string
    base_url: string
    /** OpenAI upstream API. Absent on legacy providers means Chat Completions. */
    api_type?: 'responses' | 'chat_completions'
    timeout?: number
    enable_timeout?: boolean
    max_retries?: number
    version?: string
    /** Persistent Codex installation identifier generated by LLMHub. */
    device_id?: string
    /** ChatGPT account/workspace id extracted from the OAuth token. */
    account_id?: string
    /** ChatGPT OAuth refresh token. Never returned by provider APIs. */
    refresh_token?: string
    /** ChatGPT OAuth ID token. Never returned by provider APIs. */
    id_token?: string
    /** Access-token expiry as epoch milliseconds, when the token is a JWT. */
    token_expires_at?: number
    /** Codex client version sent when fetching the subscription model catalog. */
    client_version?: string
    /** Automatically redeem a banked reset after Codex rejects a request for exhausted quota. */
    auto_reset_on_quota_exhausted?: boolean
    /** Use Google One AI Credits once after Antigravity explicitly reports exhausted free quota. */
    use_ai_credits_on_quota_exhausted?: boolean
    /** Non-secret subscription plan reported during OAuth (for example pro or max). */
    subscription_type?: string
    /** Non-secret upstream rate-limit tier reported during OAuth. */
    rate_limit_tier?: string
    /** Google Cloud Code project selected for an Antigravity subscription. */
    project_id?: string
    /** Google account email used by Antigravity. Never returned by provider APIs. */
    account_email?: string
    /** Schema-validated runtime provider configuration; may contain secrets. */
    extra?: Record<string, unknown>
  }
  models: ModelConfig[]
  defaults?: {
    temperature?: number
    max_tokens?: number
  }
}

export interface ModelConfig {
  id: string
  display_name: string
  context_window?: number
  max_output_tokens?: number
  capabilities?: {
    vision?: boolean
    tools?: boolean
    streaming?: boolean
  }
}

// ============ 模型信息 ============
export interface ModelInfo {
  id: string
  provider: string
  name: string
  display_name: string
  capabilities?: {
    vision?: boolean
    tools?: boolean
    streaming?: boolean
  }
}

// ============ Protocol Parser 接口 ============
export interface ProtocolParser {
  name: string
  canHandle(url: string, method: string, body: any): boolean
  parseRequest(body: any): LLMRequest
  parseStreamChunk(chunk: any): LLMStreamChunk
}

// ============ Protocol Serializer 接口 ============
export interface ProtocolSerializer {
  name: string
  serializeResponse(response: LLMResponse): any
  serializeStreamChunk(chunk: LLMStreamChunk): any
}

// ============ Provider Adapter 接口 ============
export interface ProviderAdapter {
  name: string
  toProviderRequest(request: LLMRequest): any
  call(request: any): Promise<any>
  callStream(request: any): ReadableStream | Promise<ReadableStream>
  fromProviderResponse(response: any): LLMResponse
  fromProviderStreamChunk(chunk: any, state?: any): LLMStreamChunk | LLMStreamChunk[]
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>
  getModels(): ModelInfo[]
}

export type SafeProviderConnection = Omit<ProviderConfig['connection'],
  'api_key' | 'refresh_token' | 'id_token' | 'device_id' | 'account_id' | 'project_id' | 'account_email'>
  & { authenticated: boolean }

export interface ModelDiscoveryContext {
  /** Fetch with the loader's fixed ten-second timeout and one retry. */
  fetcher(url: string, options?: RequestInit): Promise<Response>
}

export interface ProviderManagement {
  /** Schema-based plugin fields are accepted unless explicitly disabled. */
  acceptsExtra?: boolean
  /** Legacy creation forms read credentials only from the flat request body. */
  flatCreateCredentials?: boolean
  /** Direct creation and transitions into this type require a separate connection flow. */
  creationError?: string
  protectedConnectionFields?: readonly string[]
  /** Top-level fields with provider-owned normalization rules. */
  flatConnectionFields?: Readonly<Record<string, (value: unknown) => unknown>>
  /** Fill fields still absent after common storage normalization; never override its defaults. */
  createConnectionDefaults?: Partial<ProviderConfig['connection']>
}

export interface ProviderDefinition {
  id: string
  displayName?: string
  connectionSchema?: PluginField[]
  management?: ProviderManagement
  createAdapter(config: ProviderConfig): ProviderAdapter
  fetchModels(config: ProviderConfig, context: ModelDiscoveryContext): Promise<ModelInfo[]>
  secretConnectionFields: readonly string[]
  requiresRefreshToken?: boolean
  refreshAccessToken?(config: ProviderConfig): Promise<ProviderConfig>
  subscriptionUsage?(config: ProviderConfig, fetcher: typeof fetch): Promise<SubscriptionUsage>
  resetSubscriptionUsage?(config: ProviderConfig, creditId: string | undefined, idempotencyKey: string, fetcher: typeof fetch): Promise<SubscriptionResetResult>
  login?: { path: string }
}

export interface SubscriptionUsageWindow {
  id: string
  label: string
  used_percent: number
  reset_at?: string
  detail?: string
}

export interface SubscriptionResetCredit {
  id: string
  reset_type: string
  status: string
  granted_at?: string
  expires_at?: string
  title?: string
  description?: string
}

export interface SubscriptionUsage {
  provider: string
  protocol: string
  plan?: string
  windows: SubscriptionUsageWindow[]
  credits?: {
    balance?: number | string
    unlimited?: boolean
    detail?: string
  }
  reset_credits?: {
    available_count: number
    credits?: SubscriptionResetCredit[]
  }
  fetched_at: string
}

export interface SubscriptionResetResult {
  code: string
  windows_reset: number
}

export interface FallbackStrategy {
  enabled: boolean
  name: string
  priority: string[]
}

export interface ApiKeyRecord {
  id: string
  name: string
  hash: string
  allowed_providers: string[]
  allowed_models: string[]
  monthly_limit: number        // 0 = unlimited
  tokens_used: number          // this month
  current_month: string        // "2025-06"
  call_count: number           // total
  created_at: string
  model_quotas: Record<string, number>     // model_id -> monthly token limit
  model_usage: Record<string, number>      // model_id -> tokens used this month
  provider_quotas: Record<string, number>  // provider_name -> monthly token limit
  provider_usage: Record<string, number>   // provider_name -> tokens used this month
  fallback_strategy: FallbackStrategy
}

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

/** Accounting boundaries are emitted where the legacy routes observed them. */
export type AccountingCompletion =
  | { kind: 'attempt' }
  | { kind: 'usage'; usage: number | Usage; model?: string; tokens?: number }

export interface CompletionInfo {
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
  onAccountingComplete?: (completion: AccountingCompletion, context: HookContext) => Awaitable<void>
  onNormalize?: (request: LLMRequest, context: HookContext) => Awaitable<LLMRequest | void>
  onRequest?: (request: LLMRequest, context: HookContext) => Awaitable<LLMRequest | void>
  onResponse?: (response: LLMResponse, context: HookContext) => Awaitable<LLMResponse | void>
  /** undefined preserves the chunk, null or [] drops it. */
  onStreamChunk?: (chunk: LLMStreamChunk, context: HookContext) => Awaitable<LLMStreamChunk | LLMStreamChunk[] | null | void>
  onError?: (error: unknown, context: HookContext) => Awaitable<void>
  onComplete?: (completion: CompletionInfo, context: HookContext) => Awaitable<void>
}

export interface ProtocolDefinition {
  /** Registry identity; callers must use this ID, not parser.name, to select a serializer. */
  id: string
  createParser(): ProtocolParser
  createSerializer(): ProtocolSerializer
}

export interface IngressModel {
  model: string
  replace(model: string): void
}

export interface IngressDefinition {
  id: string
  pathPrefix: string
  extractKey(event: H3Event): string
  missingKeyMessage: string
  extractModel(event: H3Event): IngressModel | Promise<IngressModel>
  rewriteBeforeRejection: boolean
  sendError(event: H3Event, rejection: AdmissionRejection): unknown | Promise<unknown>
}
