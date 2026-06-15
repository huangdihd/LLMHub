import { ProviderManager } from '../../providers/manager'
import type { EmbeddingRequest } from '../../core/types'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)

  if (!body || body.input == null) {
    const manager = new ProviderManager()
    throwFormattedError(manager.buildGatewayError('Missing required field: input', 400))
  }

  const model: string = body.model || ''
  const input = normalizeOpenAIInput(body.input)
  if (input.length === 0) {
    const manager = new ProviderManager()
    throwFormattedError(manager.buildGatewayError('input must not be empty', 400))
  }

  const manager = new ProviderManager()
  await manager.loadProviders()

  const request: EmbeddingRequest = {
    model,
    input,
    dimensions: typeof body.dimensions === 'number' ? body.dimensions : undefined,
    encodingFormat: body.encoding_format === 'base64' ? 'base64' : 'float'
  }

  try {
    incrementCalls().catch(() => {})
    const result = await manager.embed(request)

    trackUsage(event, result.usage.totalTokens || 0, model)

    const useBase64 = request.encodingFormat === 'base64'
    return {
      object: 'list',
      data: result.embeddings.map((emb, index) => ({
        object: 'embedding',
        index,
        embedding: useBase64 ? encodeEmbeddingBase64(emb) : emb
      })),
      model: result.model || model,
      usage: {
        prompt_tokens: result.usage.promptTokens,
        total_tokens: result.usage.totalTokens
      }
    }
  } catch (error: any) {
    throwFormattedError(error)
  }
})
