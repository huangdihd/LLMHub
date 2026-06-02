import { join } from 'path'
import { readFileSync, existsSync } from 'fs'

export default defineEventHandler(async (event) => {
  try {
    const name = getRouterParam(event, 'name')
    const providersDir = join(process.cwd(), 'providers')
    const filePath = join(providersDir, `${name}.json`)

    if (!existsSync(filePath)) {
      throw createError({ statusCode: 404, message: 'Provider not found' })
    }

    const content = readFileSync(filePath, 'utf-8')
    const provider = JSON.parse(content)

    return { provider }
  } catch (error: any) {
    if (error.statusCode) throw error
    throwFormattedError(error)
  }
})
