import { ProviderManager } from '../../../providers/manager'

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
      incrementCalls().catch(() => {})
      const result = await manager.embed({ model: fullModel, input, dimensions, taskType, title })
      trackUsage(event, result.usage.totalTokens || 0, fullModel)

      if (action === 'embedContent') {
        return { embedding: { values: result.embeddings[0] || [] } }
      }
      return { embeddings: result.embeddings.map(values => ({ values })) }
    } catch (e: any) {
      throwFormattedError(e)
    }
  }

  let request
  try {
    const parser = manager.getParser(`/models/X:${action}`, 'POST', {})
    if (!parser) throwFormattedError(manager.buildGatewayError('Invalid request', 400))
    const body = await readBody(event)
    request = (parser as any).parseRequest(body, fullModel)
  } catch (e: any) {
    throwFormattedError(manager.buildGatewayError(`Parse error: ${e.message}`, 400))
  }

  if (!request.model) request.model = fullModel

  if (action === 'generateContent') {
    try {
      incrementCalls().catch(() => {})
      const response = await manager.callLLM(request)
      const serializer = manager.getSerializer('gemini-generate')
      if (!serializer) throwFormattedError(manager.buildGatewayError('Serializer not found', 500))
      const u = response.usage
      trackUsage(event, (u?.promptTokens || 0) + (u?.completionTokens || 0), request.model)
      return serializer.serializeResponse(response)
    } catch (e: any) {
      throwFormattedError(e)
    }
  }

  // streamGenerateContent
  request.stream = true
  try {
    incrementCalls().catch(() => {})
    const resolved = manager.resolveAdapter(request.model || '', 'gemini-generate', true)
    if (!resolved) throwFormattedError(manager.buildGatewayError(`No adapter found for model: ${request.model}`, 404))

    const adapter = resolved.adapter
    const providerRequest = adapter.toProviderRequest({ ...request, stream: true })

    setResponseHeaders(event, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    event.node.res.flushHeaders()

    const keepAliveTimer = setInterval(() => {
      if (!event.node.res.writableEnded) event.node.res.write(': ping\n\n')
    }, 15000)

    try {
      const serializer = manager.getSerializer('gemini-generate')
      const stream = adapter.callStream(providerRequest)
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let lineBuffer = ''
      let providerState = {}
      let doneSent = false

      const processLine = (line: string) => {
        if (!line.startsWith('data: ')) return
        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          if (!doneSent) { doneSent = true; event.node.res.write(`data: ${JSON.stringify(serializer!.serializeStreamChunk({ type: 'done' }))}\n\n`) }
          return
        }
        if (!data) return
        try {
          const originalChunk = JSON.parse(data)
          const unifiedChunksRaw = adapter!.fromProviderStreamChunk(originalChunk, providerState)
          const unifiedChunks = Array.isArray(unifiedChunksRaw) ? unifiedChunksRaw : [unifiedChunksRaw]
          for (const uc of unifiedChunks) {
            if (uc.type === 'done') {
              if (doneSent) { const u = (uc as any).usage; if (u) trackUsage(event, (u.promptTokens || 0) + (u.completionTokens || 0), request.model); return }
              doneSent = true
              const u = (uc as any).usage; if (u) trackUsage(event, (u.promptTokens || 0) + (u.completionTokens || 0), request.model)
              event.node.res.write(`data: ${JSON.stringify(serializer!.serializeStreamChunk(uc))}\n\n`)
            } else if (uc.type !== 'content' || uc.delta) {
              event.node.res.write(`data: ${JSON.stringify(serializer!.serializeStreamChunk(uc))}\n\n`)
            }
          }
        } catch {}
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        lineBuffer += decoder.decode(value, { stream: true })
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() || ''
        for (const l of lines) processLine(l)
      }
      if (lineBuffer.trim()) processLine(lineBuffer.trim())
    } catch (e: any) {
      if (!event.node.res.headersSent) throwFormattedError(manager.buildGatewayError(e.message, 500))
      else event.node.res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`)
    } finally {
      clearInterval(keepAliveTimer)
      if (!event.node.res.writableEnded) event.node.res.end()
    }
    return
  } catch (e: any) {
    throwFormattedError(e)
  }
})
