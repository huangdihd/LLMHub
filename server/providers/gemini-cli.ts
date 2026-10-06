import { randomUUID } from 'node:crypto'
import type { ModelConfig, ProviderConfig } from '../core/types'
import { ensureGeminiCliAccessToken } from '../services/gemini-cli-token-manager'
import { GEMINI_CLI_API_BASE_URL, geminiCliHeaders } from '../utils/gemini-cli-auth'
import { fetchWithRetry } from '../utils/fetch'
import { GeminiAdapter } from './gemini'

export const DEFAULT_GEMINI_CLI_MODELS: ModelConfig[] = [
  { id: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', capabilities: { vision: true, tools: true, streaming: true } },
  { id: 'gemini-3-flash', display_name: 'Gemini 3 Flash', capabilities: { vision: true, tools: true, streaming: true } },
  { id: 'gemini-3-pro-preview', display_name: 'Gemini 3 Pro Preview', capabilities: { vision: true, tools: true, streaming: true } },
  { id: 'gemini-3.1-pro-preview', display_name: 'Gemini 3.1 Pro Preview', capabilities: { vision: true, tools: true, streaming: true } }
]

export class GeminiCliAdapter extends GeminiAdapter {
  override name = 'gemini-cli'

  override async call(input: any): Promise<any> {
    const { modelId: model, payload } = input
    const config = await ensureGeminiCliAccessToken(this.config)
    const response = await fetchWithRetry(`${baseUrl(config)}/v1internal:generateContent`, {
      method: 'POST',
      headers: geminiCliHeaders(config.connection.api_key),
      body: JSON.stringify(wrapGeminiCliRequest(model, payload, config.connection.project_id!))
    }, config.connection)
    if (!response.ok) throw await geminiCliApiError(response)
    const body = await response.json() as any
    if (!body?.response) throw new Error('Gemini CLI returned an invalid response')
    return body.response
  }

  override callStream(input: any): ReadableStream<Uint8Array> {
    const { modelId: model, payload } = input
    const self = this
    return new ReadableStream({
      async start(controller) {
        try {
          const config = await ensureGeminiCliAccessToken(self.config)
          const abortController = new AbortController()
          const timeout = config.connection.enable_timeout === false
            ? undefined
            : setTimeout(() => abortController.abort(), config.connection.timeout ?? 120000)
          let response: Response
          try {
            response = await fetch(`${baseUrl(config)}/v1internal:streamGenerateContent?alt=sse`, {
              method: 'POST',
              headers: { ...geminiCliHeaders(config.connection.api_key), 'Accept': 'text/event-stream' },
              body: JSON.stringify(wrapGeminiCliRequest(model, payload, config.connection.project_id!)),
              signal: abortController.signal
            })
          } finally {
            if (timeout) clearTimeout(timeout)
          }
          if (!response.ok || !response.body) throw await geminiCliApiError(response)
          await pipeGeminiCliSse(
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

  override async embed(): Promise<never> {
    const error: any = new Error('Gemini CLI subscription does not support embeddings through LLMHub')
    error._statusCode = 501
    error._providerError = false
    throw error
  }
}

export function wrapGeminiCliRequest(model: string, payload: any, project: string): any {
  return {
    model,
    project,
    user_prompt_id: randomUUID(),
    request: {
      ...payload,
      session_id: randomUUID()
    }
  }
}

async function pipeGeminiCliSse(
  response: Response,
  controller: ReadableStreamDefaultController<Uint8Array>,
  idleTimeoutMs: number
): Promise<void> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, idleTimeoutMs)
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() || ''
      for (const frame of frames) emitFrame(frame, controller, encoder)
    }
    buffer += decoder.decode()
    if (buffer.trim()) emitFrame(buffer, controller, encoder)
    controller.close()
  } finally {
    reader.releaseLock()
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
          const error = new Error(`Gemini CLI stream was idle for ${idleTimeoutMs}ms`)
          void reader.cancel(error).catch(() => {})
          reject(error)
        }, idleTimeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function emitFrame(
  frame: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder
): void {
  const data = frame.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
  if (!data) return

  const parsed = JSON.parse(data)
  if (!parsed?.response) return
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed.response)}\n\n`))
}

function baseUrl(config: ProviderConfig): string {
  return (config.connection.base_url || GEMINI_CLI_API_BASE_URL).replace(/\/$/, '')
}

async function geminiCliApiError(response: Response): Promise<Error> {
  const text = await response.text().catch(() => '')
  let message = `Gemini CLI API request failed (${response.status})`
  let code: string | undefined
  try {
    const body = JSON.parse(text)
    message = body.error?.message || body.message || message
    code = body.error?.status
  } catch {}
  const error: any = new Error(message)
  error.statusCode = response.status
  error._statusCode = response.status
  error._providerError = true
  error._errorBody = { message, type: 'api_error', code }
  return error
}
