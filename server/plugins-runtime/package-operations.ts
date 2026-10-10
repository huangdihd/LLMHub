import { execFile } from 'node:child_process'
import { compare, gt, satisfies, valid } from 'semver'
import { githubSpecification, npmSpecification, validateRegistry, type PackageSpecification } from './specifications'

export interface PackageCommandOptions {
  timeout: number
  maxBuffer: number
  encoding: 'utf8'
  shell: false
  killSignal: 'SIGKILL'
  windowsHide: true
  env: NodeJS.ProcessEnv
}
export type PackageExecutor = (file: string, arguments_: string[], options: PackageCommandOptions) => Promise<string>

const execute: PackageExecutor = (file, arguments_, options) => new Promise((resolve, reject) => {
  execFile(file, arguments_, options, (error, stdout) => error ? reject(error) : resolve(stdout))
})

function run(executor: PackageExecutor, file: string, arguments_: string[]): Promise<string> {
  return executor(file, arguments_, {
    timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', shell: false, killSignal: 'SIGKILL', windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

function failureReason(error: unknown): string {
  const failure = error as { code?: unknown; killed?: boolean }
  if (failure?.code === 'ENOENT') return 'Executable not found'
  if (failure?.killed || failure?.code === 'ETIMEDOUT') return 'Command timed out'
  // Subprocess stderr may contain registry credentials; do not expose it to clients.
  return 'Command failed (network, authentication, or remote service unavailable)'
}

export interface PackageCapability { available: boolean; version?: string; reason?: string }
export async function packageCapabilities(executor: PackageExecutor = execute): Promise<{ npm: PackageCapability; git: PackageCapability }> {
  async function probe(file: string): Promise<PackageCapability> {
    try {
      const version = (await run(executor, file, ['--version'])).trim()
      return version ? { available: true, version } : { available: false, reason: 'Empty executable version response' }
    } catch (error) { return { available: false, reason: failureReason(error) } }
  }
  const [npm, git] = await Promise.all([probe('npm'), probe('git')])
  return { npm, git }
}

export interface PackageUpdateSource extends PackageSpecification { commit?: string }
export interface PackageUpdate {
  version: string
  ref?: string
  commit?: string
}
export interface PackageUpdates {
  available: boolean
  currentVersion: string
  /** npm dist-tag latest, which may differ from the greatest published version. */
  latestVersion?: string
  /** Greatest published version satisfying the stored range, or null if none match. */
  latestMatchingVersion?: string | null
  updates: PackageUpdate[]
  reason?: string
  trackedRef?: { ref: string; currentCommit?: string; commit: string; changed: boolean | null }
}

/** Queries remote metadata only: no installation, lifecycle scripts, or GitHub API. */
export async function packageUpdates(
  source: PackageUpdateSource,
  registry: string,
  currentVersion: string,
  executor: PackageExecutor = execute,
): Promise<PackageUpdates> {
  const unavailable = (reason: string): PackageUpdates => ({ available: false, currentVersion, updates: [], reason })
  if (!valid(currentVersion)) return unavailable('Installed version is not valid semver')
  try {
    if (source.source === 'npm') {
      const specification = npmSpecification({ name: source.packageName, version: source.range })
      const output = await run(executor, 'npm', ['view', specification.packageName!, 'versions', '--json', '--registry', validateRegistry(registry)])
      const response: unknown = JSON.parse(output)
      const versions = typeof response === 'string' ? [response] : response
      if (!Array.isArray(versions) || versions.some(version => typeof version !== 'string' || !valid(version))) {
        return unavailable('npm registry returned invalid version metadata')
      }
      const updates = [...new Set(versions as string[])].filter(version => gt(version, currentVersion)).sort(compare).map(version => ({ version }))
      const latestOutput = await run(executor, 'npm', ['view', specification.packageName!, 'dist-tags.latest', '--json', '--registry', validateRegistry(registry)])
      const latestVersion: unknown = JSON.parse(latestOutput)
      if (typeof latestVersion !== 'string' || !valid(latestVersion)) {
        return unavailable('npm registry returned invalid latest version metadata')
      }
      const latestMatchingVersion = (versions as string[]).filter(version => satisfies(version, specification.range ?? '*')).sort(compare).at(-1) ?? null
      return { available: true, currentVersion, updates, latestVersion, latestMatchingVersion }
    }
    if (source.source !== 'github') return unavailable('Unsupported package source')
    const specification = githubSpecification({ owner: source.owner, repo: source.repo, ref: source.ref })
    const output = await run(executor, 'git', ['ls-remote', `https://github.com/${specification.owner}/${specification.repo}.git`, 'HEAD', 'refs/tags/*', 'refs/heads/*'])
    const references = new Map<string, string>()
    for (const line of output.split('\n')) {
      if (!line.trim()) continue
      const match = /^([a-f0-9]{40}|[a-f0-9]{64})\s+(HEAD|refs\/(?:heads|tags)\/[^\s]+)$/.exec(line.trim())
      if (!match) return unavailable('Git remote returned invalid reference metadata')
      references.set(match[2]!, match[1]!)
    }
    if (!references.size) return unavailable('Git remote returned no references')
    const updates: PackageUpdate[] = []
    for (const [reference, commit] of references) {
      if (reference === 'HEAD' || reference.endsWith('^{}')) continue
      const shortRef = reference.replace(/^refs\/(?:heads|tags)\//, '')
      const version = valid(shortRef)
      if (!version || !gt(version, currentVersion)) continue
      // Preserve the namespace when a branch and tag share a name, so the
      // advertised tag cannot accidentally install the same-named branch.
      const ambiguous = references.has(`refs/heads/${shortRef}`) && references.has(`refs/tags/${shortRef}`)
      const ref = ambiguous ? reference : shortRef
      updates.push({ version, ref, commit: references.get(`${reference}^{}`) ?? commit })
    }
    updates.sort((left, right) => compare(left.version, right.version) || left.ref!.localeCompare(right.ref!))
    const ref = specification.ref ?? 'HEAD'
    let reference = ref
    if (ref !== 'HEAD' && !ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
      reference = references.has(`refs/heads/${ref}`) ? `refs/heads/${ref}` : `refs/tags/${ref}`
    }
    const commit = references.get(`${reference}^{}`) ?? references.get(reference)
    if (!commit) {
      if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref)) return { available: true, currentVersion, updates }
      return unavailable('Tracked Git reference is unavailable')
    }
    return { available: true, currentVersion, updates, trackedRef: { ref, currentCommit: source.commit, commit, changed: source.commit ? source.commit !== commit : null } }
  } catch (error) {
    return unavailable(error instanceof SyntaxError ? 'npm registry returned invalid JSON' : failureReason(error))
  }
}
