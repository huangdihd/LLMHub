import type { SystemBuildInformation } from '../../shared/types/system-update'
import { SystemUpdateManager } from './manager'
import { runGit } from './releases'
import { createUpdateFiles } from './update-files'

let manager: SystemUpdateManager | undefined

export function getSystemUpdateManager(): SystemUpdateManager {
  if (manager) return manager
  const directory = process.env.LLMHUB_INSTALL_DIR || process.cwd()
  const build = useRuntimeConfig().public.buildInformation as SystemBuildInformation
  manager = new SystemUpdateManager({
    build, environment: process.env, directory, development: process.env.NODE_ENV !== 'production',
    git: runGit, files: createUpdateFiles(directory), storage: useStorage('data')
  })
  return manager
}
