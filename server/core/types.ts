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
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: Content
  meta?: MessageMeta
}

export type Content = string | ContentBlock[]

export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result' | 'thinking' | 'redacted_thinking'
  text?: string
  thinking?: string
  signature?: string
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
  content: string
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
export interface GenerateConfig {
  maxTokens?: number
  temperature?: number
  topP?: number
  stop?: string[]
  systemPrompt?: string
  thinkingConfig?: {
    thinkingBudget?: number
    includeThoughts?: boolean
  }
}

// ============ 统一响应 ============
export interface LLMResponse {
  content: Content
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error'
  toolCalls?: ToolCall[]
  usage: Usage
}

export interface ToolCall {
  id: string
  name: string
  input: object
  thoughtSignature?: string
}

export interface Usage {
  promptTokens: number
  completionTokens: number
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
  type: 'content' | 'thinking' | 'tool_call' | 'done' | 'error'
  delta?: string
  toolCall?: ToolCallDelta
  finishReason?: string
  usage?: Usage
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
  protocol: 'openai' | 'claude' | 'gemini'
  enabled: boolean
  use_custom_models: boolean
  normalize_cch?: boolean
  connection: {
    api_key: string
    base_url: string
    timeout?: number
    enable_timeout?: boolean
    max_retries?: number
    version?: string
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
  callStream(request: any): ReadableStream
  fromProviderResponse(response: any): LLMResponse
  fromProviderStreamChunk(chunk: any, state?: any): LLMStreamChunk | LLMStreamChunk[]
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>
  getModels(): ModelInfo[]
}
