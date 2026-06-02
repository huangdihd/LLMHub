import { join } from 'path'
import { writeFileSync, existsSync } from 'fs'
import type { ProviderConfig } from '../../core/types'

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event)
    const providersDir = join(process.cwd(), 'providers')

    if (!body.name) {
      throw createError({ statusCode: 400, message: 'Provider name is required' })
    }

    const filePath = join(providersDir, `${body.name}.json`)

    if (existsSync(filePath)) {
      throw createError({ statusCode: 409, message: `Provider '${body.name}' already exists` })
    }

    const newProvider: ProviderConfig = {
      name: body.name,
      display_name: body.display_name || body.name,
      protocol: body.protocol || 'openai',
      enabled: body.enabled !== false,
      use_custom_models: body.use_custom_models || false,
      connection: {
        api_key: body.api_key || '',
        base_url: body.base_url || '',
        timeout: body.timeout || 30000,
        max_retries: body.max_retries || 3,
        version: body.version
      },
      models: body.models || [],
      defaults: body.defaults || { temperature: 0.7, max_tokens: 4096 }
    }

    writeFileSync(filePath, JSON.stringify(newProvider, null, 2), 'utf-8')

    return { success: true, provider: newProvider }
  } catch (error: any) {
    if (error.statusCode) throw error
    throwFormattedError(error)
  }
})
