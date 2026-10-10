import type { SystemBuildInformation, SystemDeployment, SystemReleaseCheck, SystemUpdateOverview } from '../../shared/types/system-update'
import { OFFICIAL_REPOSITORY, compareVersions, latestStableRelease, releaseUrl, sameRepository, type RunGit } from './releases'
import { isActiveUpdate, type UpdateFiles } from './update-files'
import { safeUpdateError } from './errors'

export interface SystemSettingsStorage {
  getItem<T>(key: string): Promise<T | null>
  setItem(key: string, value: { automatic: boolean }): Promise<unknown>
}
export interface SystemManagerOptions {
  build: SystemBuildInformation
  environment: NodeJS.ProcessEnv
  directory: string
  development: boolean
  git: RunGit
  files: UpdateFiles
  storage: SystemSettingsStorage
}
export class SystemUpdateError extends Error {
  constructor(public statusCode: number, message: string) { super(message) }
}

export class SystemUpdateManager {
  private checkState: SystemReleaseCheck = { status: 'unchecked' }
  private checking: Promise<SystemReleaseCheck> | null = null
  private requesting = false
  constructor(private readonly options: SystemManagerOptions) {}

  async automatic(): Promise<boolean> {
    return (await this.options.storage.getItem<{ automatic: boolean }>('system:updates:settings'))?.automatic !== false
  }

  async setAutomatic(automatic: boolean): Promise<{ automatic: boolean }> {
    await this.options.storage.setItem('system:updates:settings', { automatic })
    return { automatic }
  }

  private async installation() {
    const { environment, build, development, directory, git, files } = this.options
    let deployment: SystemDeployment = 'unknown'
    if (development) deployment = 'development'
    else if (build.deployment === 'docker') deployment = 'docker'
    else if (environment.LLMHUB_DEPLOYMENT === 'service' && environment.LLMHUB_INSTALL_DIR) deployment = 'service'
    let origin: string | null = null
    try { origin = (await git(['remote', 'get-url', 'origin'], directory)).trim() || null }
    catch { /* Archives and containers need not contain a Git checkout. */ }
    if (deployment === 'unknown' && origin) deployment = 'manual'
    const repository = environment.LLMHUB_UPDATE_REPOSITORY?.trim() || origin || OFFICIAL_REPOSITORY
    let canUpdate = false
    if (deployment === 'service' && origin === OFFICIAL_REPOSITORY && sameRepository(repository, origin)) {
      canUpdate = await files.source() === origin && await files.supervisorRunning()
    }
    return { deployment, repository, canUpdate }
  }

  async overview(): Promise<SystemUpdateOverview> {
    const installation = await this.installation()
    const status = await this.options.files.status()
    const pending = await this.options.files.pending()
    return {
      version: this.options.build.version, commit: this.options.build.commit,
      deployment: installation.deployment, canUpdate: installation.canUpdate,
      command: this.manualCommand(installation.deployment),
      automatic: await this.automatic(), check: { ...this.checkState },
      update: pending && !isActiveUpdate(status) ? { phase: 'downloading' } : status
    }
  }

  private manualCommand(deployment: SystemDeployment): string | null {
    if (!['docker', 'manual'].includes(deployment)) return null
    if (deployment === 'manual') {
      return "curl -fsSL https://raw.githubusercontent.com/huangdihd/LLMHub/main/install.sh | LLMHUB_INSTALL_DIR=\"$PWD\" LLMHUB_SOURCE=\"$(git remote get-url origin)\" LLMHUB_SERVICE=no sh"
    }
    // Resolve the stable tag from origin, not possibly stale or locally-created tags.
    const selectRelease = "tag=$(git ls-remote --tags origin | awk '{print $2}' | sed -nE 's@^refs/tags/(v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*))$@\\1@p' | sort -V | tail -n 1)"
    const checkout = `${selectRelease} && test -n "$tag" && test -z "$(git status --porcelain)" && git fetch origin "refs/tags/$tag" && git checkout --detach FETCH_HEAD`
    return `${checkout} && docker compose build && docker compose up -d`
  }

  check(): Promise<SystemReleaseCheck> {
    if (this.checking) return this.checking
    this.checking = this.detect().finally(() => { this.checking = null })
    return this.checking
  }

  private async detect(): Promise<SystemReleaseCheck> {
    const checkedAt = new Date().toISOString()
    try {
      const { repository } = await this.installation()
      const release = latestStableRelease(await this.options.git(['ls-remote', '--tags', '--', repository]))
      if (!release) return this.checkState = { status: 'no-releases', checkedAt }
      const version = this.options.build.version
      const available = compareVersions(release.version, version) > 0
      return this.checkState = {
        status: available ? 'available' : 'current', latestVersion: release.version,
        tag: release.tag, commit: release.commit, releaseUrl: releaseUrl(repository, release.tag), checkedAt
      }
    } catch (error) {
      return this.checkState = { status: 'failed', error: safeUpdateError(error), checkedAt }
    }
  }

  async requestUpdate(): Promise<SystemUpdateOverview> {
    if (this.requesting) throw new SystemUpdateError(409, 'An update request is already in progress.')
    this.requesting = true
    try {
      if (!(await this.installation()).canUpdate) throw new SystemUpdateError(409, 'This installation does not support one-click updates.')
      await this.assertIdle()
      // Do not reuse an earlier manual or scheduled check for an installation decision.
      if (this.checking) await this.checking
      const check = await this.check()
      if (check.status === 'failed') throw new SystemUpdateError(502, check.error || 'Release detection failed.')
      if (check.status !== 'available' || !check.tag || !check.commit) throw new SystemUpdateError(409, 'No newer stable release is available.')
      if (!(await this.installation()).canUpdate) throw new SystemUpdateError(409, 'Installation source changed.')
      await this.assertIdle()
      try { await this.options.files.publish({ tag: check.tag, commit: check.commit }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SystemUpdateError(409, 'An update is already pending.')
        throw new SystemUpdateError(500, 'Could not publish the update request.')
      }
      return await this.overview()
    } finally { this.requesting = false }
  }

  private async assertIdle() {
    if (await this.options.files.pending() || isActiveUpdate(await this.options.files.status())) {
      throw new SystemUpdateError(409, 'An update is already in progress.')
    }
  }
}
