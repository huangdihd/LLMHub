import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, mkdtemp, readdir, realpath, rm, rmdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { PluginError, safePath } from './manifest'

export interface ModuleGeneration {
  directory: string
  dispose(): Promise<void>
}

export const GENERATIONS_DIRECTORY = '.generations'

/**
 * Snapshot code and give libraries unique module identities without copying their bytes.
 * Snapshots live beside the plugins they mirror, so hard links never cross filesystems,
 * and only libraries inside `root` are mirrored; anything above it resolves in place.
 */
export async function createModuleGeneration(source: string, root = dirname(source)): Promise<ModuleGeneration> {
  await safePath(source)
  source = resolve(source)
  root = resolve(root)
  if (!source.startsWith(`${root}${sep}`)) root = dirname(source)
  const generations = join(root, GENERATIONS_DIRECTORY)
  await mkdir(generations, { recursive: true })
  const temporaryRoot = await mkdtemp(join(await realpath(generations), 'generation-'))
  const snapshotPath = (filename: string) => join(temporaryRoot, relative(root, filename))
  const directory = snapshotPath(source)
  const dispose = async () => {
    const cache = createRequire(join(directory, 'package.json')).cache
    const prefix = `${temporaryRoot}${sep}`
    // Drop the entire generation, including hoisted libraries and parent references.
    // Node exposes no corresponding eviction API for its ESM module map.
    for (const [filename, module] of Object.entries(cache)) {
      if (filename.startsWith(prefix)) delete cache[filename]
      else if (module) module.children = module.children.filter(child => !child.filename.startsWith(prefix))
    }
    await rm(temporaryRoot, { recursive: true, force: true })
    // Leave nothing behind once the last generation is gone.
    await rmdir(generations).catch(() => {})
  }
  const linkedDirectories = new Set<string>()
  const linkDirectory = async (original: string, destination: string): Promise<void> => {
    // Dirents avoid realpath/stat calls for every ordinary library file. Keep
    // traversal bounded and asynchronous even for a complete host dependency tree.
    const pending: Array<() => Promise<void>> = []
    const enqueueDirectory = (filename: string, target: string, parents: Set<string>) => {
      pending.push(async () => {
        if (filename === source || linkedDirectories.has(target)) return
        await mkdir(target, { recursive: true })
        for (const entry of await readdir(filename, { withFileTypes: true })) {
          const child = join(filename, entry.name)
          const childTarget = join(target, entry.name)
          if (entry.isDirectory()) {
            enqueueDirectory(child, childTarget, new Set([...parents, child]))
            continue
          }
          pending.push(async () => {
            if (entry.isSymbolicLink()) {
              const resolved = await realpath(child)
              const information = await lstat(resolved)
              if (information.isDirectory()) {
                if (parents.has(resolved)) throw new PluginError('Cyclic library directory link')
                enqueueDirectory(resolved, childTarget, new Set([...parents, resolved]))
                return
              }
              if (!information.isFile()) throw new PluginError('Plugin libraries require regular files')
              await link(resolved, childTarget)
              return
            }
            if (!entry.isFile()) throw new PluginError('Plugin libraries require regular files')
            // Unique realpaths without copying bytes; EXDEV must fail, not copy.
            // npm replaces trees, so old generations retain their original inodes.
            await link(child, childTarget)
          })
        }
        linkedDirectories.add(target)
      })
    }
    enqueueDirectory(original, destination, new Set([await realpath(original)]))
    // Drain the entire in-flight batch before rollback, including on failure.
    while (pending.length) {
      const batch = pending.splice(0, 128)
      const results = await Promise.allSettled(batch.map(operation => operation()))
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason
      }
    }
  }
  const linkLibraries = async (original: string, destination: string): Promise<void> => {
    let information
    try { information = await lstat(original) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!information.isDirectory() || information.isSymbolicLink()) throw new PluginError('Plugin node_modules must be a regular directory')
    await linkDirectory(original, destination)
  }
  const copyDirectory = async (relativeDirectory: string): Promise<void> => {
    const entries = await readdir(await safePath(source, relativeDirectory))
    for (const name of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name
      if (name === 'node_modules') {
        await linkLibraries(join(source, relativePath), join(directory, relativePath))
        continue
      }
      const filename = await safePath(source, relativePath)
      const information = await lstat(filename)
      const destination = join(directory, relativePath)
      if (information.isDirectory()) {
        await mkdir(destination)
        await copyDirectory(relativePath)
        continue
      }
      if (!information.isFile()) throw new PluginError('Plugin generation requires regular files')
      await copyFile(filename, destination, constants.COPYFILE_EXCL)
    }
  }
  try {
    await mkdir(directory, { recursive: true })
    // Mirror ancestor libraries up to the plugins root; bare imports retain their lookup order.
    for (let ancestor = dirname(source); ; ancestor = dirname(ancestor)) {
      // A package inside node_modules searches its parent's node_modules, not
      // node_modules/node_modules (matching Node's own resolution algorithm).
      if (basename(ancestor) !== 'node_modules') {
        await linkLibraries(join(ancestor, 'node_modules'), join(snapshotPath(ancestor), 'node_modules'))
      }
      if (ancestor === root) break
    }
    await copyDirectory('')
    return { directory, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
