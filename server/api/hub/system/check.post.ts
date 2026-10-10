import { getSystemUpdateManager } from '../../../system/runtime'
import { requireSystemSession, requireEmptySystemRequest, systemOperation } from '../../../system/http'

export default defineEventHandler(async event => {
  await requireSystemSession(event)
  await requireEmptySystemRequest(event)
  return systemOperation(async () => {
    const manager = getSystemUpdateManager()
    await manager.check()
    return manager.overview()
  })
})
