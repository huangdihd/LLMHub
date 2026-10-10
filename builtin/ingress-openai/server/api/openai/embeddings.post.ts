import { normalizeOpenAIInput, encodeEmbeddingBase64 } from '../../../embedding'
import { RequestPipeline } from '../../../../../server/core/pipeline'
import { ProviderManager } from '../../../../../server/providers/manager'
import type { EmbeddingRequest } from '../../../../../server/core/types'

export default defineEventHandler(async (event) => {
  const manager = new ProviderManager()
  const pipeline = new RequestPipeline(manager, event, 'openai-embedding')
  try {
    const body = await readBody(event)

    if (!body || body.input == null) {
      throwFormattedError(manager.buildGatewayError('Missing required field: input', 400))
    }

    const model: string = body.model || ''
    const input = normalizeOpenAIInput(body.input)
    if (input.length === 0) {
      throwFormattedError(manager.buildGatewayError('input must not be empty', 400))
    }

    await manager.loadProviders()

    const request: EmbeddingRequest = {
      model,
      input,
      dimensions: typeof body.dimensions === 'number' ? body.dimensions : undefined,
      encodingFormat: body.encoding_format === 'base64' ? 'base64' : 'float'
    }

    try {
      const result = await pipeline.embed(request)

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
      await pipeline.error(error)
      throwFormattedError(error)
    }
  } catch (error) {
    await pipeline.error(error)
    throw error
  } finally {
    await pipeline.complete()
  }
})
