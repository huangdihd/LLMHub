import { join } from 'path'
import { readFileSync, readdirSync } from 'fs'
import type { ProviderConfig } from '../../core/types'

export default defineEventHandler(async (event) => {
  try {
    const providersDir = join(process.cwd(), 'providers')
    const files = readdirSync(providersDir).filter(f => f.endsWith('.json'))

    const providers: ProviderConfig[] = files.map(file => {
      const content = readFileSync(join(providersDir, file), 'utf-8')
      return JSON.parse(content)
    })

    return { providers }
  } catch (error: any) {
    throwFormattedError(error)
  }
})
