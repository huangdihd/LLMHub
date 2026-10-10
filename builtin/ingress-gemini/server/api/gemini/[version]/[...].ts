import { geminiContentToText } from '../../../../embedding'
import { completeIngressAccounting } from '../../../../../../server/core/accounting'
import { ProviderManager } from '../../../../../../server/providers/manager'
import { RequestPipeline } from '../../../../../../server/core/pipeline'

export default defineEventHandler(async (event) => {
  const rawPath = event.context.params?._ || ''
  const method = event.method
  let action: string | undefined
  let modelEncoded: string | undefined

  if (rawPath.endsWith(':generateContent')) {
    action = 'generateContent'
    modelEncoded = rawPath.slice('models/'.length, -':generateContent'.length)
  } else if (rawPath.endsWith(':streamGenerateContent')) {
    action = 'streamGenerateContent'
    modelEncoded = rawPath.slice('models/'.length, -':streamGenerateContent'.length)
  } else if (rawPath.endsWith(':embedContent')) {
    action = 'embedContent'
    modelEncoded = rawPath.slice('models/'.length, -':embedContent'.length)
  } else if (rawPath.endsWith(':batchEmbedContents')) {
    action = 'batchEmbedContents'
    modelEncoded = rawPath.slice('models/'.length, -':batchEmbedContents'.length)
  } else if (rawPath.endsWith('/generateContent')) {
    action = 'generateContent'
    modelEncoded = rawPath.slice('models/'.length, -'/generateContent'.length)
  } else if (rawPath.endsWith('/streamGenerateContent')) {
    action = 'streamGenerateContent'
    modelEncoded = rawPath.slice('models/'.length, -'/streamGenerateContent'.length)
  } else if (rawPath.endsWith('/embedContent')) {
    action = 'embedContent'
    modelEncoded = rawPath.slice('models/'.length, -'/embedContent'.length)
  } else if (rawPath.endsWith('/batchEmbedContents')) {
    action = 'batchEmbedContents'
    modelEncoded = rawPath.slice('models/'.length, -'/batchEmbedContents'.length)
  }

  if (!action || !modelEncoded || method !== 'POST') {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  const model = decodeURIComponent(modelEncoded)

  const manager = new ProviderManager()
  await manager.loadProviders()

  const resolvedModel = (event as any).context?._resolvedModel
  const fullModel = resolvedModel || model

  // ===== Embeddings: embedContent / batchEmbedContents =====
  if (action === 'embedContent' || action === 'batchEmbedContents') {
    let body: any
    try {
      body = await readBody(event)
    } catch (e: any) {
      throwFormattedError(manager.buildGatewayError(`Parse error: ${e.message}`, 400))
    }

    let input: Array<string | number[]>
    let dimensions: number | undefined
    let taskType: string | undefined
    let title: string | undefined

    if (action === 'embedContent') {
      input = [geminiContentToText(body?.content)]
      dimensions = typeof body?.outputDimensionality === 'number' ? body.outputDimensionality : undefined
      taskType = body?.taskType
      title = body?.title
    } else {
      const requests = Array.isArray(body?.requests) ? body.requests : []
      input = requests.map((r: any) => geminiContentToText(r?.content))
      const first = requests[0] || {}
      dimensions = typeof first.outputDimensionality === 'number' ? first.outputDimensionality : undefined
      taskType = first.taskType
      title = first.title
    }

    if (input.length === 0) {
      throwFormattedError(manager.buildGatewayError('No content provided to embed', 400))
    }

    try {
      completeIngressAccounting(event, 'gemini-embedding', { kind: 'attempt' }).catch(() => {})
      const result = await manager.embed({ model: fullModel, input, dimensions, taskType, title })
      completeIngressAccounting(event, 'gemini-embedding', { kind: 'usage', usage: result.usage.totalTokens || 0, model: fullModel })

      if (action === 'embedContent') {
        return { embedding: { values: result.embeddings[0] || [] } }
      }
      return { embeddings: result.embeddings.map(values => ({ values })) }
    } catch (e: any) {
      throwFormattedError(e)
    }
  }

  const pipeline = new RequestPipeline(manager, event, 'gemini-generate')
  try {
    let request
    try {
      const parser = manager.getParser(`/models/X:${action}`, 'POST', {})
      if (!parser) throwFormattedError(manager.buildGatewayError('Invalid request', 400))
      const body = await readBody(event)
      request = (parser as any).parseRequest(body, fullModel)
    } catch (e: any) {
      await pipeline.error(e)
      throwFormattedError(manager.buildGatewayError(`Parse error: ${e.message}`, 400))
    }

    if (!request.model) request.model = fullModel
    request = (await pipeline.prepare(request)).request

    if (action === 'generateContent') {
      try {
        pipeline.accountingComplete({ kind: 'attempt' }).catch(() => {})
        const response = await pipeline.call(request)
        const serializer = manager.getSerializer('gemini-generate')
        if (!serializer) throwFormattedError(manager.buildGatewayError('Serializer not found', 500))
        const u = response.usage
        pipeline.accountingComplete({ kind: 'usage', usage: u || 0, model: request.model })
        return serializer.serializeResponse(response)
      } catch (e: any) {
        await pipeline.error(e)
        throwFormattedError(e)
      }
    }

    // streamGenerateContent
    // With ?alt=sse the reply is an SSE stream; without it the official API
    // returns one JSON array of GenerateContentResponse chunks.
    request.stream = true
    const useSSE = getQuery(event).alt === 'sse'
    try {
      pipeline.accountingComplete({ kind: 'attempt' }).catch(() => {})
      const resolved = pipeline.resolve(request)
      if (!resolved) throwFormattedError(manager.buildGatewayError(`No adapter found for model: ${request.model}`, 404))

      const adapter = resolved.adapter
      const stream = await pipeline.openStream(request, adapter)

      let keepAliveTimer: any = null
      const collected: any[] = []

      if (useSSE) {
        setResponseHeaders(event, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        })
        event.node.res.flushHeaders()

        keepAliveTimer = setInterval(() => {
          if (!event.node.res.writableEnded) event.node.res.write(': ping\n\n')
        }, 15000)
      }

      const emit = (serialized: any) => {
        if (useSSE) event.node.res.write(`data: ${JSON.stringify(serialized)}\n\n`)
        else collected.push(serialized)
      }

      try {
        const serializer = manager.getSerializer('gemini-generate')

        let doneSent = false

        await pipeline.consumeStream(stream, adapter, {
          onChunks: (unifiedChunks) => {
            for (const uc of unifiedChunks) {
              if (uc.type === 'done') {
                if (doneSent) { const u = (uc as any).usage; if (u) pipeline.accountingComplete({ kind: 'usage', usage: u, model: request.model }); return }
                doneSent = true
                const u = (uc as any).usage; if (u) pipeline.accountingComplete({ kind: 'usage', usage: u, model: request.model })
                emit(serializer!.serializeStreamChunk(uc))
              } else {
                // Serializer buffers partial tool-call args and returns null for them
                const serialized = serializer!.serializeStreamChunk(uc)
                if (serialized) emit(serialized)
              }
            }
          },
          onDoneMarker: () => {
            if (!doneSent) { doneSent = true; emit(serializer!.serializeStreamChunk({ type: 'done' })) }
          },
          onChunkError: (e) => {
            console.error('[LLMHub] gemini: failed to process stream chunk, dropping it:', e)
          }
        })

        // Upstream ended without a terminal chunk — still close the response
        if (!doneSent) {
          doneSent = true
          emit(serializer!.serializeStreamChunk({ type: 'done' }))
        }
      } catch (e: any) {
        await pipeline.error(e)
        if (!useSSE || !event.node.res.headersSent) throwFormattedError(manager.buildGatewayError(e.message, 500))
        else event.node.res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`)
      } finally {
        if (keepAliveTimer) clearInterval(keepAliveTimer)
        if (useSSE && !event.node.res.writableEnded) event.node.res.end()
      }

      if (!useSSE) return collected
      return
    } catch (e: any) {
      await pipeline.error(e)
      throwFormattedError(e)
    }
  } catch (error) {
    await pipeline.error(error)
    throw error
  } finally {
    await pipeline.complete()
  }
})
