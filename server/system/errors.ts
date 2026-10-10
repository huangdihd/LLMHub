// Return only fixed descriptions: subprocess output may contain credentials or paths.
export function safeUpdateError(error: unknown): string {
  const value = error as { code?: unknown; killed?: unknown; message?: unknown } | null
  const message = typeof error === 'string' ? error : typeof value?.message === 'string' ? value.message : ''
  const safeMessages = [
    'Git executable or working directory was not found.',
    'Permission denied while accessing update resources.',
    'Update operation timed out.',
    'Repository authentication failed.',
    'Could not connect to the release repository.',
    'Release repository was not found or is inaccessible.',
    'Installed version is not a valid semantic version.',
    'Git could not complete the repository operation.'
  ]
  if (safeMessages.includes(message)) return message
  if (value?.code === 'ENOSPC' || /ENOSPC|no space left|insufficient.*space/i.test(message)) return 'Not enough disk space to prepare the release.'
  if (value?.code === 'ENOENT') return 'Git executable or working directory was not found.'
  if (value?.code === 'EACCES' || value?.code === 'EPERM' || /permission denied/i.test(message)) return 'Permission denied while accessing update resources.'
  if (value?.killed || /timed? out|timeout/i.test(message)) return 'Update operation timed out.'
  if (/authentication failed|could not read Username|terminal prompts disabled|access denied/i.test(message)) return 'Repository authentication failed.'
  if (/could not resolve|unable to access|failed to connect|network is unreachable/i.test(message)) return 'Could not connect to the release repository.'
  if (/repository .*not found|does not appear to be a git repository/i.test(message)) return 'Release repository was not found or is inaccessible.'
  if (/origin changed|recorded official origin|recorded origin|installation source changed/i.test(message)) return 'Installation source changed or is not supported.'
  if (/changed locally|local changes|working tree|checkout is not clean|modified checkout/i.test(message)) return 'Local checkout changes prevent a safe update.'
  if (/tag .*match|tag changed/i.test(message)) return 'Release tag no longer matches the requested commit.'
  if (/before readiness|health check|application process exited/i.test(message)) return 'The updated application failed its readiness check.'
  if (/interrupted update rolled back/i.test(message)) return 'An interrupted update was rolled back.'
  if (/npm failed \(exit \d+\)/i.test(message)) return 'Dependency installation or application build failed.'
  if (/git failed \(exit \d+\)|git operation failed/i.test(message)) return 'Git could not complete the repository operation.'
  return 'Update failed. Inspect the local supervisor logs.'
}
