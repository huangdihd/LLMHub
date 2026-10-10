import { validRange } from 'semver'
import { PluginError } from './manifest'

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
export interface PackageSpecification {
  source: 'npm' | 'github'
  specification: string
  packageName?: string
  range?: string
  owner?: string
  repo?: string
  ref?: string
}

export function validatePackageName(input: unknown): string {
  if (typeof input !== 'string' || input.length > 214 || /\s/.test(input) || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(input)
    || ['node_modules', 'favicon.ico'].includes(input)) throw new PluginError('Invalid npm package name')
  return input
}

export function npmSpecification(input: unknown): PackageSpecification {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PluginError('Provide npm name and optional version separately')
  const { name, version } = input as Record<string, unknown>
  const packageName = validatePackageName(name)
  if (version !== undefined && (typeof version !== 'string' || version.length > 256 || /\s/.test(version) || !/^[a-zA-Z0-9~^*<>=.+-]+$/.test(version) || !validRange(version))) {
    throw new PluginError('Invalid npm version or semver range')
  }
  const range = version as string | undefined
  return { source: 'npm', specification: `${packageName}${range ? `@${range}` : ''}`, packageName, range }
}

export function githubSpecification(input: unknown): PackageSpecification {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PluginError('Provide GitHub owner, repo and optional ref, or url')
  let { owner, repo, ref, url } = input as Record<string, unknown>
  if (url !== undefined) {
    if (owner !== undefined || repo !== undefined || ref !== undefined || typeof url !== 'string' || url.length > 1024 || /\s/.test(url)) throw new PluginError('Provide either GitHub url or owner/repo/ref')
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/(.+))?\/?$/.exec(url)
    if (!match) throw new PluginError('Only https://github.com/owner/repo URLs are supported')
    ;[, owner, repo, ref] = match
  }
  if (typeof owner !== 'string' || owner.length > 39 || /\s/.test(owner) || !/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(owner)
    || typeof repo !== 'string' || repo.length > 100 || /\s/.test(repo) || !/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/.test(repo) || repo === '.' || repo === '..' || repo.endsWith('.git')) throw new PluginError('Invalid GitHub owner or repository')
  if (ref !== undefined && (typeof ref !== 'string' || ref.length > 256 || /\s/.test(ref) || !/^[a-zA-Z0-9][a-zA-Z0-9._/+-]*$/.test(ref)
    || ref.includes('..') || ref.includes('//') || ref.endsWith('.') || ref.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock')))) throw new PluginError('Invalid GitHub ref')
  return { source: 'github', specification: `github:${owner}/${repo}${ref ? `#${ref}` : ''}`, owner, repo, ref: ref as string | undefined }
}

export function validateRegistry(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048 || /[\s\\]/.test(input)) throw new PluginError('Invalid npm registry URL')
  let url: URL
  try { url = new URL(input) } catch { throw new PluginError('Invalid npm registry URL') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new PluginError('Registry must be an HTTP(S) URL without credentials, query or fragment')
  return url.href.replace(/\/?$/, '/')
}
