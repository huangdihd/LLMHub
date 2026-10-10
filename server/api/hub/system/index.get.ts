import { getSystemUpdateManager } from '../../../system/runtime'
import { requireSystemSession, systemOperation } from '../../../system/http'

export default defineEventHandler(async event => {
  await requireSystemSession(event)
  return systemOperation(() => getSystemUpdateManager().overview())
})
