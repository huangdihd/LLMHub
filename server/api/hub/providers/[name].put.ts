import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import type { ProviderConfig } from '../../../core/types'

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event)
    const providersDir = join(process.cwd(), 'providers')

    if (!body.name) {
      throw createError({ statusCode: 400, message: 'Provider name is required' })
    }

    const filePath = join(providersDir, `${body.name}.json`)

    let existing: ProviderConfig = {
      name: body.name,
      display_name: body.name,
      protocol: 'openai',
      enabled: true,
      use_custom_models: false,
      connection: { api_key: '', base_url: '' },
      models: []
    }

    try {
      existing = JSON.parse(readFileSync(filePath, 'utf-8'))
    } catch (e) {
      // File doesn't exist, use defaults
    }

    const updated: ProviderConfig = {
      ...existing,
      ...body,
      connection: {
        ...existing.connection,
        ...body.connection
      }
    }

    writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8')

    return { success: true, provider: updated }
  } catch (error: any) {
    if (error.statusCode) throw error
    throwFormattedError(error)
  }
})
