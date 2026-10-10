import { execFile } from 'node:child_process'
import { safeUpdateError } from './errors'

export const OFFICIAL_REPOSITORY = 'https://github.com/huangdihd/LLMHub.git'
const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const commitPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i

export interface StableRelease { tag: string; version: string; commit: string }
export type RunGit = (arguments_: string[], directory?: string) => Promise<string>

export const runGit: RunGit = (arguments_, directory) => new Promise((resolve, reject) => {
  execFile('git', arguments_, {
    cwd: directory, timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
    encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  }, (error, stdout, stderr) => {
    // Never propagate stderr or the command: remote URLs can contain credentials.
    if (error) return reject(new Error(safeUpdateError({ code: error.code, killed: error.killed, message: stderr || error.message })))
    resolve(stdout)
  })
})

export function compareVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
    if (!match || match[4]?.split('.').some(part => /^0\d+$/.test(part))) throw new Error('Installed version is not a valid semantic version.')
    return { core: match.slice(1, 4).map(part => BigInt(part!)), prerelease: match[4]?.split('.') }
  }
  const firstVersion = parse(left)
  const secondVersion = parse(right)
  const first = firstVersion.core
  const second = secondVersion.core
  for (let index = 0; index < 3; index++) {
    if (first[index]! > second[index]!) return 1
    if (first[index]! < second[index]!) return -1
  }
  const firstPrerelease = firstVersion.prerelease
  const secondPrerelease = secondVersion.prerelease
  if (!firstPrerelease && !secondPrerelease) return 0
  if (!firstPrerelease) return 1
  if (!secondPrerelease) return -1
  for (let index = 0; index < Math.max(firstPrerelease.length, secondPrerelease.length); index++) {
    const leftPart = firstPrerelease[index]
    const rightPart = secondPrerelease[index]
    if (leftPart === rightPart) continue
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart > rightPart ? 1 : -1
  }
  return 0
}

export function latestStableRelease(output: string): StableRelease | null {
  const tags = new Map<string, { object?: string; peeled?: string }>()
  for (const line of output.split('\n')) {
    const match = /^([a-f0-9]{40}(?:[a-f0-9]{24})?)\s+refs\/tags\/(v[^\s]+?)(\^\{\})?$/i.exec(line.trim())
    if (!match || !stableTag.test(match[2]!)) continue
    const entry = tags.get(match[2]!) || {}
    if (match[3]) entry.peeled = match[1]!.toLowerCase()
    else entry.object = match[1]!.toLowerCase()
    tags.set(match[2]!, entry)
  }
  const tag = [...tags.keys()].filter(tag => tags.get(tag)!.object).sort(compareVersions).at(-1)
  if (!tag) return null
  const entry = tags.get(tag)!
  return { tag, version: tag.slice(1), commit: entry.peeled || entry.object! }
}

export function sameRepository(left: string, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\/$/, '').replace(/\.git$/, '')
  return normalize(left) === normalize(right)
}

export function releaseUrl(repository: string, tag: string): string | undefined {
  try {
    const url = new URL(repository)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) return undefined
    return `${url.origin}${url.pathname.replace(/\/$/, '').replace(/\.git$/, '')}/releases/tag/${tag}`
  } catch { return undefined }
}
