import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { PluginError, safePath, validatePackageManifest } from './manifest'
import { githubSpecification, npmSpecification, validatePackageName, validateRegistry } from './specifications'
import type { PluginManifest } from '../../shared/types/plugin'

export interface PackagePlugin {
  invalid?: boolean
  error?: string
  manifest: PluginManifest
  directory: string
  packageName: string
  packageDependencies: Record<string, string>
  optionalPackageDependencies: Record<string, string>
}
export type NpmRunner = (arguments_: string[], directory: string) => Promise<void>

export const runNpm: NpmRunner = (arguments_, directory) => new Promise((fulfill, reject) => {
  execFile('npm', arguments_, { cwd: directory, timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, windowsHide: true, shell: false, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', npm_config_ignore_scripts: 'true' } }, error => {
    if (error) { reject(new PluginError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'npm is unavailable: install Node.js with npm and ensure npm is on the server PATH' : error.killed ? 'npm operation timed out; check registry connectivity and retry' : 'npm install failed; check package specification, registry connectivity, and server filesystem permissions')); return }
    fulfill()
  })
})

export async function installProject(directory: string, dependencies: Record<string, string>, registry: string, runner: NpmRunner): Promise<void> {
  const validatedRegistry = validateRegistry(registry)
  for (const [name, specification] of Object.entries(dependencies)) {
    validatePackageName(name)
    if (typeof specification !== 'string') throw new PluginError('Invalid npm dependency specification')
    if (!specification.startsWith('github:')) {
      npmSpecification({ name, version: specification })
      continue
    }
    const match = /^github:([^/]+)\/([^#]+)(?:#(.+))?$/.exec(specification)
    if (!match) throw new PluginError('Invalid GitHub dependency specification')
    const validated = githubSpecification({ owner: match[1], repo: match[2], ref: match[3] })
    if (validated.specification !== specification) throw new PluginError('Invalid GitHub dependency specification')
  }
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, 'package.json'), JSON.stringify({ name: 'llmhub-runtime-plugins', version: '1.0.0', private: true, dependencies }))
  await runner(['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=true', '--registry', validatedRegistry], directory)
}

/** Discover metadata without executing code; ordinary npm libraries are not gateway plugins. */
export async function discoverPackages(project: string, tolerateInvalid = false): Promise<PackagePlugin[]> {
  const plugins: PackagePlugin[] = []
  const packageDirectories = new Set<string>()
  const visitModules = async (directory: string): Promise<void> => {
    let entries
    try { entries = await readdir(await safePath(directory), { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const packageDirectory = await safePath(directory, entry.name)
      if (!entry.isDirectory()) throw new PluginError('npm packages must be regular directories')
      if (entry.name.startsWith('@')) { await visitModules(packageDirectory); continue }
      const metadata = JSON.parse(await readFile(await safePath(packageDirectory, 'package.json'), 'utf8'))
      packageDirectories.add(packageDirectory)
      if (Object.hasOwn(metadata, 'llmhub')) {
        let manifest: PluginManifest
        let invalid = false
        try {
          manifest = validatePackageManifest(metadata)
          await safePath(packageDirectory, manifest.entry!)
        } catch (error) {
          if (!tolerateInvalid) throw error
          const id = typeof metadata.llmhub?.id === 'string' ? metadata.llmhub.id : String(metadata.name).replace(/^@/, '').replace('/', '-')
          manifest = { id, name: String(metadata.name), version: 'unknown' }
          invalid = true
        }
        if (plugins.some(plugin => plugin.manifest.id === manifest.id)) throw new PluginError('Duplicate npm plugin identity')
        const packageDependencies: Record<string, string> = { ...metadata.peerDependencies, ...metadata.dependencies }
        const optionalPackageDependencies: Record<string, string> = { ...metadata.optionalDependencies }
        for (const [name, range] of Object.entries(metadata.peerDependencies ?? {})) {
          if (metadata.peerDependenciesMeta?.[name]?.optional !== true || Object.hasOwn(metadata.dependencies ?? {}, name)) continue
          optionalPackageDependencies[name] ??= range as string
          delete packageDependencies[name]
        }
        // npm optionalDependencies override dependencies of the same name.
        for (const name of Object.keys(optionalPackageDependencies)) delete packageDependencies[name]
        plugins.push({ manifest, invalid, error: invalid ? 'Invalid npm plugin manifest or entry; reinstall a valid package' : undefined, directory: packageDirectory, packageName: metadata.name, packageDependencies, optionalPackageDependencies })
      }
      await visitModules(resolve(packageDirectory, 'node_modules'))
    }
  }
  await visitModules(resolve(project, 'node_modules'))
  const packages = new Map(plugins.map(plugin => [plugin.directory, plugin]))
  const projectDirectory = resolve(project)
  for (const plugin of plugins) {
    for (const [dependencies, key] of [[plugin.packageDependencies, 'dependencies'], [plugin.optionalPackageDependencies, 'optionalDependencies']] as const) {
      for (const [name, range] of Object.entries(dependencies)) {
        validatePackageName(name)
        // Resolve from the importer: a nested library shadows a hoisted plugin,
        // and packages installed under siblings are not visible to this plugin.
        for (let ancestor = plugin.directory; ; ancestor = dirname(ancestor)) {
          const dependencyDirectory = resolve(ancestor, 'node_modules', name)
          if (packageDirectories.has(dependencyDirectory)) {
            const dependency = packages.get(dependencyDirectory)
            if (dependency) plugin.manifest[key] = { ...plugin.manifest[key], [dependency.manifest.id]: plugin.manifest[key]?.[dependency.manifest.id] ?? range }
            break
          }
          if (ancestor === projectDirectory || ancestor === dirname(ancestor)) break
        }
      }
    }
  }
  return plugins
}
