import { access, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { SystemUpdateStatus, SystemUpdatePhase } from '../../shared/types/system-update'
import { commitPattern } from './releases'
import { safeUpdateError } from './errors'

const phases: SystemUpdatePhase[] = ['downloading', 'installing', 'building', 'switching', 'restarting', 'completed', 'failed']
export const isActiveUpdate = (status: SystemUpdateStatus | null) => !!status && !['completed', 'failed'].includes(status.phase)

async function readJSON(path: string): Promise<any> {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('Update state could not be read.')
  }
}

export interface UpdateFiles {
  status(): Promise<SystemUpdateStatus | null>
  source(): Promise<string | null>
  supervisorRunning(): Promise<boolean>
  pending(): Promise<boolean>
  publish(request: { tag: string; commit: string }): Promise<void>
}

export function createUpdateFiles(root: string): UpdateFiles {
  const directory = join(root, '.data', 'updates')
  return {
    async status() {
      const value = await readJSON(join(directory, 'status.json'))
      if (!value) return null
      if (!phases.includes(value.stage ?? value.phase)) throw new Error('Invalid update status.')
      return {
        phase: value.stage ?? value.phase,
        ...(typeof value.tag === 'string' && /^v\d+\.\d+\.\d+$/.test(value.tag) ? { tag: value.tag } : {}),
        ...(typeof value.commit === 'string' && commitPattern.test(value.commit) ? { commit: value.commit } : {}),
        ...(typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)) ? { updatedAt: value.updatedAt } : {}),
        // Classify existing supervisor messages; never expose raw commands, paths or URLs.
        ...(value.error || value.rollbackError ? { error: value.rollbackError
          ? `Rollback failed: ${safeUpdateError(value.rollbackError)}`
          : safeUpdateError(value.error) } : {})
      }
    },
    async source() {
      const source = (await readJSON(join(directory, 'source.json')))?.source
      return typeof source === 'string' && source.trim() ? source : null
    },
    async supervisorRunning() {
      const owner = await readJSON(join(directory, 'supervisor.lock', 'owner.json'))
      if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) return false
      try { process.kill(owner.pid, 0); return true }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
    },
    async pending() {
      try { await access(join(directory, 'request.json')); return true }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw new Error('Update state could not be read.')
      }
    },
    async publish(request) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = join(directory, `.request-${randomUUID()}.json`)
      await writeFile(temporary, JSON.stringify(request), { flag: 'wx', mode: 0o600 })
      try {
        // A hard link publishes complete bytes atomically and refuses an existing request.
        await link(temporary, join(directory, 'request.json'))
      } finally { await unlink(temporary) }
    }
  }
}
