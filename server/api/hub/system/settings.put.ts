import { createError, getQuery, readBody } from 'h3'
import { getSystemUpdateManager } from '../../../system/runtime'
import { requireSystemSession, systemOperation } from '../../../system/http'

export default defineEventHandler(async event => {
  await requireSystemSession(event)
  const body = await readBody(event)
  if (Object.keys(getQuery(event)).length || !body || Array.isArray(body)
    || typeof body.automatic !== 'boolean' || Object.keys(body).some(key => key !== 'automatic')) {
    throw createError({ statusCode: 400, statusMessage: 'Expected only an automatic boolean.' })
  }
  return systemOperation(() => getSystemUpdateManager().setAutomatic(body.automatic))
})
