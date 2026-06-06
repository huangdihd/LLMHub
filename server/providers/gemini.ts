import type { ProviderAdapter, ProviderConfig, LLMRequest, LLMResponse, LLMStreamChunk, ModelInfo, ContentBlock } from '../core/types'
import { fetchWithRetry } from '../utils/fetch'
import { sanitizeGeminiSchema } from '../utils/sanitize-gemini-schema'

export class GeminiAdapter implements ProviderAdapter {
  name = 'gemini'

  constructor(private config: ProviderConfig) {}

  toProviderRequest(request: LLMRequest): any {
    const contents: any[] = []

    for (const msg of request.messages) {
      if (msg.role === 'system') continue

      const role = msg.role === 'assistant' ? 'model' : 'user'
      const parts = this.convertContentToParts(msg.content, msg.role)

      if (msg.role === 'assistant' && msg.meta?.toolCalls?.length) {
        for (const tc of msg.meta.toolCalls) {
          parts.push({
            functionCall: {
              name: tc.name,
              args: typeof tc.input === 'string' ? this.safeJsonParse(tc.input || '{}') : tc.input,
              thought_signature: tc.thoughtSignature || ''
            }
          })
        }
      }

      if (msg.role === 'tool' && msg.meta?.toolCallId) {
        const textContent = typeof msg.content === 'string'
          ? msg.content
          : (msg.content as any[])
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('\n')

        parts.length = 0
        parts.push({
          functionResponse: {
            id: msg.meta.toolCallId,
            name: msg.meta.name || 'unknown',
            response: { output: textContent }
          }
        })
      }

      if (parts.length > 0) {
        if (contents.length > 0 && contents[contents.length - 1].role === role) {
          contents[contents.length - 1].parts.push(...parts)
        } else {
          contents.push({ role, parts })
        }
      }
    }

    const slashIndex = request.model?.indexOf('/')
    const modelId = slashIndex !== undefined && slashIndex !== -1 ? request.model!.slice(slashIndex + 1) : request.model

    const payload: any = {
      contents,
      generationConfig: {}
    }

    if (request.config.systemPrompt) {
      payload.systemInstruction = {
        parts: [{ text: request.config.systemPrompt }]
      }
    }

    if (request.config.temperature != null) {
      payload.generationConfig.temperature = request.config.temperature
    }
    if (request.config.topP != null) {
      payload.generationConfig.topP = request.config.topP
    }
    if (request.config.maxTokens > 0) {
      payload.generationConfig.maxOutputTokens = request.config.maxTokens
    }
    if (request.config.stop?.length) {
      payload.generationConfig.stopSequences = request.config.stop
    }

    if (request.config.thinkingConfig) {
      payload.thinkingConfig = {}
      if (request.config.thinkingConfig.thinkingBudget != null) {
        payload.thinkingConfig.thinkingBudget = request.config.thinkingConfig.thinkingBudget
      }
      if (request.config.thinkingConfig.includeThoughts != null) {
        payload.thinkingConfig.includeThoughts = request.config.thinkingConfig.includeThoughts
      }
    }

    if (request.tools && request.tools.length > 0) {
      payload.tools = [{
        functionDeclarations: request.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: sanitizeGeminiSchema(t.parameters)
        }))
      }]
    }

    return { modelId, payload }
  }

  private convertContentToParts(content: any, role: string): any[] {
    if (typeof content === 'string') {
      return content ? [{ text: content }] : []
    }

    if (!Array.isArray(content)) return []

    const parts: any[] = []
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        parts.push({ text: block.text })
      } else if (block.type === 'image') {
        if (block.imageBase64) {
          parts.push({
            inlineData: {
              data: block.imageBase64,
              mimeType: block.imageMediaType || 'image/jpeg'
            }
          })
        } else if (block.imageUrl) {
          if (block.imageUrl.startsWith('data:')) {
            const match = block.imageUrl.match(/^data:([^;]+);base64,(.+)$/)
            if (match) {
              parts.push({
                inlineData: {
                  data: match[2],
                  mimeType: match[1]
                }
              })
              continue
            }
          }
          parts.push({
            fileData: {
              fileUri: block.imageUrl,
              mimeType: block.imageMediaType || 'image/jpeg'
            }
          })
        }
      } else if (block.type === 'tool_use' && role === 'assistant') {
        parts.push({
          functionCall: {
            id: block.toolUse.id,
            name: block.toolUse.name,
              args: typeof block.toolUse.input === 'string'
                ? this.safeJsonParse(block.toolUse.input || '{}')
                : block.toolUse.input
          }
        })
      } else if (block.type === 'tool_result' && role === 'tool') {
        parts.push({
          functionResponse: {
            id: block.toolResult.toolUseId,
            name: block.toolResult.name || 'unknown',
            response: { output: block.toolResult.content || '' }
          }
        })
      } else if (block.type === 'thinking') {
        parts.push({ text: block.thinking || '', thought: true })
      }
    }
    return parts
  }

  async call(request: any): Promise<any> {
    const { modelId, payload } = request
    const url = `${this.config.connection.base_url}/v1beta/models/${modelId}:generateContent`

    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.config.connection.api_key
      },
      body: JSON.stringify(payload)
    }, this.config.connection)

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      let errorObj: any
      try {
        errorObj = JSON.parse(errorBody)
      } catch {
        errorObj = { message: errorBody || response.statusText }
      }
      const err: any = new Error(JSON.stringify(errorObj))
      err._providerError = true
      err._statusCode = response.status
      err._errorBody = errorObj
      err._source = this.config.name
      throw err
    }

    return response.json()
  }

  callStream(request: any): ReadableStream {
    const { modelId, payload } = request
    const config = this.config
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    return new ReadableStream({
      start(controller) {
        ;(async () => {
          const abortController = new AbortController()
          let timeoutId: any
          if (config.connection.enable_timeout) {
            timeoutId = setTimeout(() => abortController.abort(), config.connection.timeout || 30000)
          }

          let reader: ReadableStreamDefaultReader | undefined
          let closed = false
          const safeClose = () => {
            if (closed) return
            closed = true
            try { controller.close() } catch {}
          }
          const safeError = (err: any) => {
            if (closed) return
            closed = true
            try { controller.error(err) } catch {}
          }

          try {
            const url = `${config.connection.base_url}/v1beta/models/${modelId}:streamGenerateContent?alt=sse`
            const response = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': config.connection.api_key
              },
              body: JSON.stringify({ ...payload, generationConfig: { ...payload.generationConfig } }),
              signal: abortController.signal
            })

            if (timeoutId) clearTimeout(timeoutId)

            if (!response.ok) {
              const errorBody = await response.text().catch(() => '')
              let errorObj: any
              try {
                errorObj = JSON.parse(errorBody)
              } catch {
                errorObj = { message: errorBody || response.statusText }
              }
              const err: any = new Error(JSON.stringify(errorObj))
              err._providerError = true
              err._statusCode = response.status
              err._errorBody = errorObj
              err._source = config.name
              throw err
            }

            reader = response.body?.getReader()
            if (!reader) throw new Error('No response body')

            const READ_TIMEOUT_MS = config.connection.enable_timeout ? (config.connection.timeout || 30000) / 2 : 0
            const readWithTimeout = async (r: ReadableStreamDefaultReader): Promise<ReadableStreamReadResult<any>> => {
              let idleTimeoutId: any
              const timeoutPromise = new Promise<never>((_, rej) => {
                if (READ_TIMEOUT_MS > 0) {
                  idleTimeoutId = setTimeout(() => rej(new Error(`Upstream stream read timeout (${READ_TIMEOUT_MS}ms)`)), READ_TIMEOUT_MS)
                }
              })
              try {
                if (READ_TIMEOUT_MS > 0) {
                  return await Promise.race([r.read(), timeoutPromise])
                } else {
                  return await r.read()
                }
              } finally {
                if (idleTimeoutId) clearTimeout(idleTimeoutId)
              }
            }

            let buffer = ''
            let streamEnded = false

            while (!streamEnded) {
              const { done, value } = await readWithTimeout(reader)
              if (done) break

              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split('\n')
              buffer = lines.pop() || ''

              for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed) continue

                if (trimmed.startsWith('data: ')) {
                  const data = trimmed.slice(6).trim()
                  if (!data) continue
                  try {
                    const chunk = JSON.parse(data)
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                  } catch (e) {}
                }
              }
            }

            if (buffer.trim().startsWith('data: ')) {
              const data = buffer.trim().slice(6).trim()
              if (data) {
                try {
                  const chunk = JSON.parse(data)
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                } catch (e) {}
              }
            }

            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          } catch (err) {
            safeError(err)
          } finally {
            if (timeoutId) clearTimeout(timeoutId)
            if (reader) {
              reader.cancel().catch(() => {})
            }
            safeClose()
          }
        })()
      }
    })
  }

  fromProviderResponse(response: any): LLMResponse {
    const candidate = response.candidates?.[0]
    if (!candidate) {
      return {
        content: '',
        finishReason: 'error',
        usage: { promptTokens: 0, completionTokens: 0 }
      }
    }

    const parts = candidate.content?.parts || []
    const content: ContentBlock[] = []
    const toolCalls: any[] = []

    for (const part of parts) {
      if (part.text) {
        if (part.thought === true) {
          content.push({ type: 'thinking', thinking: part.text })
        } else {
          content.push({ type: 'text', text: part.text })
        }
      }
      if (part.functionCall) {
        toolCalls.push({
          id: part.functionCall.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: part.functionCall.name,
          input: part.functionCall.args || {},
          thoughtSignature: part.functionCall.thought_signature || ''
        })
      }
    }

    const finishReason = this.mapFinishReason(candidate.finishReason)

    return {
      content: content.length > 0 ? content : '',
      finishReason,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: response.usageMetadata?.promptTokenCount || 0,
        completionTokens: response.usageMetadata?.candidatesTokenCount || 0
      }
    }
  }

  fromProviderStreamChunk(chunk: any, state: any = {}): LLMStreamChunk | LLMStreamChunk[] {
    const candidate = chunk.candidates?.[0]
    if (!candidate) {
      if (chunk.usageMetadata) {
        return {
          type: 'done',
          usage: {
            promptTokens: chunk.usageMetadata.promptTokenCount || 0,
            completionTokens: chunk.usageMetadata.candidatesTokenCount || 0
          }
        }
      }
      return { type: 'content', delta: '' }
    }

    const parts = candidate.content?.parts || []
    const chunks: LLMStreamChunk[] = []

    for (const part of parts) {
      if (part.text) {
        if (part.thought === true) {
          chunks.push({ type: 'thinking', delta: part.text })
        } else {
          chunks.push({ type: 'content', delta: part.text })
        }
      }
      if (part.functionCall) {
        chunks.push({
          type: 'tool_call',
          toolCall: {
            index: state._toolIndex ?? 0,
            id: part.functionCall.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: part.functionCall.name,
            inputDelta: JSON.stringify(part.functionCall.args || {}),
            thoughtSignature: part.functionCall.thought_signature || ''
          }
        })
        state._toolIndex = (state._toolIndex ?? 0) + 1
      }
    }

    if (candidate.finishReason) {
      chunks.push({
        type: 'done',
        finishReason: this.mapFinishReason(candidate.finishReason),
        usage: chunk.usageMetadata ? {
          promptTokens: chunk.usageMetadata.promptTokenCount || 0,
          completionTokens: chunk.usageMetadata.candidatesTokenCount || 0
        } : undefined
      })
    }

    if (chunks.length === 0) {
      return { type: 'content', delta: '' }
    }

    return chunks.length === 1 ? chunks[0] : chunks
  }

  private mapFinishReason(reason: string | undefined): 'stop' | 'length' | 'tool_calls' | 'error' {
    switch (reason) {
      case 'STOP':
        return 'stop'
      case 'MAX_TOKENS':
        return 'length'
      case 'SAFETY':
      case 'RECITATION':
      case 'LANGUAGE':
      case 'OTHER':
      case 'FINISH_REASON_UNSPECIFIED':
        return 'error'
      default:
        return 'stop'
    }
  }

  getModels(): ModelInfo[] {
    return this.config.models.map(m => ({
      id: `${this.config.name}/${m.id}`,
      provider: this.config.name,
      name: m.id,
      display_name: m.display_name,
      capabilities: m.capabilities
    }))
  }

  private safeJsonParse(str: string): object {
    try {
      return JSON.parse(str)
    } catch {
      return {}
    }
  }
}
