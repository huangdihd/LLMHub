export const manifest = {
  id: 'example-echo', name: 'Local Echo', version: '1.0.0',
  engines: { llmhub: '^1.0.0' },
  description: 'A network-free upstream for exercising every gateway protocol.'
}

export default {
  setup(api) {
    const models = configuration => [{
      id: `${configuration.name}/echo`, provider: configuration.name,
      name: 'echo', display_name: 'Local echo', capabilities: { streaming: true }
    }]
    api.registerProvider({
      id: 'echo', displayName: 'Local Echo',
      connectionSchema: [{ key: 'prefix', label: 'Response prefix', type: 'text', default: '' }],
      secretConnectionFields: [],
      async fetchModels(configuration) { return models(configuration) },
      createAdapter(configuration) {
        const response = request => ({
          content: `${configuration.connection.extra?.prefix || ''}${request.config.systemPrompt || ''}|${request.messages.map(message => typeof message.content === 'string' ? message.content : message.content.map(block => block.text || '').join('')).join('|')}`,
          finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 }
        })
        return {
          name: configuration.name,
          toProviderRequest(request) { return request },
          async call(request) { return response(request) },
          callStream(request) {
            const result = response(request)
            const encoder = new TextEncoder()
            return new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'content', delta: result.content })}\n\ndata: ${JSON.stringify({ type: 'done', finishReason: 'stop', usage: result.usage })}\n\ndata: [DONE]\n\n`))
                controller.close()
              }
            })
          },
          fromProviderResponse(result) { return result },
          fromProviderStreamChunk(chunk) { return chunk },
          async embed() { throw new Error('Local echo does not support embeddings') },
          getModels() { return models(configuration) }
        }
      }
    })
    api.registerRoute('GET', 'status', () => ({ ready: true, network: false }))
  }
}
