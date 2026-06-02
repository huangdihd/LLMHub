import { join } from 'path'
import { unlinkSync, existsSync } from 'fs'

export default defineEventHandler(async (event) => {
  try {
    const name = getRouterParam(event, 'name')
    const providersDir = join(process.cwd(), 'providers')
    const filePath = join(providersDir, `${name}.json`)

    if (!existsSync(filePath)) {
      throw createError({ statusCode: 404, message: 'Provider not found' })
    }

    unlinkSync(filePath)

    return { success: true }
  } catch (error: any) {
    if (error.statusCode) throw error
    throwFormattedError(error)
  }
})
