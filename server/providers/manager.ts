import type { ProviderAdapter, ProtocolParser, ProtocolSerializer, ModelInfo, LLMRequest, LLMResponse } from '../core/types'
import { ProviderLoader } from './loader'
import { OpenAIAdapter } from './openai'
import { ClaudeAdapter } from './claude'
import { GeminiAdapter } from './gemini'
import { OpenAIChatParser } from '../protocols/openai-chat'
import { OpenAICompletionParser } from '../protocols/openai-completion'
import { OpenAIResponsesParser } from '../protocols/openai-responses'
import { ClaudeMessagesParser } from '../protocols/claude-messages'
import { ClaudeCompletionParser } from '../protocols/claude-completion'
import { GeminiGenerateParser } from '../protocols/gemini-generate'
import { OpenAIChatSerializer } from '../protocols/openai-chat-serializer'
import { ClaudeMessagesSerializer } from '../protocols/claude-messages-serializer'
import { GeminiGenerateSerializer } from '../protocols/gemini-generate-serializer'

export class ProviderManager {
  private loader: ProviderLoader
  private adapters: Map<string, ProviderAdapter> = new Map()
  private parsers: ProtocolParser[] = []
  private serializers: Map<string, ProtocolSerializer> = new Map()

  constructor() {
    this.loader = new ProviderLoader()

    this.parsers = [
      new OpenAIChatParser(),
      new OpenAICompletionParser(),
      new OpenAIResponsesParser(),
      new ClaudeMessagesParser(),
      new ClaudeCompletionParser(),
      new GeminiGenerateParser()
    ]

    this.serializers.set('openai-chat', new OpenAIChatSerializer())
    this.serializers.set('claude-messages', new ClaudeMessagesSerializer())
    this.serializers.set('gemini-generate', new GeminiGenerateSerializer())
  }

  async loadProviders(): Promise<void> {
    await this.loader.loadAll()

    for (const config of this.loader.getAllProviders()) {
      if (config.protocol === 'openai') {
        this.adapters.set(config.name, new OpenAIAdapter(config))
      } else if (config.protocol === 'claude') {
        this.adapters.set(config.name, new ClaudeAdapter(config))
      } else if (config.protocol === 'gemini') {
        this.adapters.set(config.name, new GeminiAdapter(config))
      }
    }
  }

  getParser(url: string, method: string, body: any): ProtocolParser | undefined {
    return this.parsers.find(p => p.canHandle(url, method, body))
  }

  getSerializer(name: string): ProtocolSerializer | undefined {
    return this.serializers.get(name)
  }

  getAdapter(providerName: string): ProviderAdapter | undefined {
    return this.adapters.get(providerName)
  }

  parseModelId(modelId: string): { provider: string; model: string } {
    return this.loader.parseModelId(modelId)
  }

  async getModels(): Promise<ModelInfo[]> {
    return this.loader.fetchAllModels()
  }

  async getProviderModels(providerName: string): Promise<ModelInfo[]> {
    return this.loader.fetchModels(providerName)
  }

  async getModelsByProtocol(protocol: string): Promise<ModelInfo[]> {
    const protocolProviders = this.loader.getAllProviders()
      .filter(c => c.protocol === protocol)
      .map(c => c.name)
    const providerSet = new Set(protocolProviders)
    const allModels = await this.loader.fetchAllModels()
    return allModels.filter(m => providerSet.has(m.provider))
  }

  getAdapterForModel(modelId: string): ProviderAdapter | undefined {
    try {
      const parsed = this.parseModelId(modelId)
      return this.adapters.get(parsed.provider)
    } catch (e) {
      const firstAdapter = this.adapters.keys().next().value
      return firstAdapter ? this.adapters.get(firstAdapter) : undefined
    }
  }

  resolveAdapter(modelId: string, incomingProtocol: string, stream?: boolean): { adapter: ProviderAdapter; providerName: string } | undefined {
    let providerName: string | undefined
    let adapter: ProviderAdapter | undefined

    try {
      const parsed = this.parseModelId(modelId)
      providerName = parsed.provider
      adapter = this.adapters.get(parsed.provider)
    } catch {
      providerName = this.adapters.keys().next().value
      if (providerName) adapter = this.adapters.get(providerName)
    }

    return adapter ? { adapter, providerName: providerName! } : undefined
  }

  buildGatewayError(message: string, statusCode: number) {
    const err: any = new Error(message)
    err._providerError = false
    err._statusCode = statusCode
    err._errorBody = { message }
    err._source = 'gateway'
    return err
  }

  async callLLM(request: LLMRequest, providerName?: string): Promise<LLMResponse> {
    let targetProvider = providerName

    if (!targetProvider && request.model) {
      try {
        const parsed = this.parseModelId(request.model)
        targetProvider = parsed.provider
      } catch (e) {
        const firstAdapter = this.adapters.keys().next().value
        if (firstAdapter) {
          targetProvider = firstAdapter
        }
      }
    }

    if (!targetProvider) {
      throw this.buildGatewayError('No provider available', 503)
    }

    const adapter = this.adapters.get(targetProvider)
    if (!adapter) {
      throw this.buildGatewayError(`Provider not found: ${targetProvider}`, 404)
    }

    const providerRequest = adapter.toProviderRequest(request)
    const providerResponse = await adapter.call(providerRequest)
    return adapter.fromProviderResponse(providerResponse)
  }
}
