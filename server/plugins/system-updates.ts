import { getSystemUpdateManager } from '../system/runtime'
import { startSystemUpdateChecks } from '../system/scheduler'

export default defineNitroPlugin(nitroApp => {
  const stop = startSystemUpdateChecks({
    automatic: () => getSystemUpdateManager().automatic(),
    check: () => getSystemUpdateManager().check()
  })
  nitroApp.hooks.hook('close', stop)
})
