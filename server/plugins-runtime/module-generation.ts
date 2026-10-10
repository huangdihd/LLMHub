import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginError, safePath } from './manifest'

export interface ModuleGeneration {
  directory: string
  dispose(): Promise<void>
}

/** A private snapshot gives every relative module a fresh URL, including lazy imports. */
export async function createModuleGeneration(source: string): Promise<ModuleGeneration> {
  await safePath(source)
  // macOS's system temporary directory can have a symlinked ancestor.
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'llmhub-plugin-generation-'))
  const dispose = () => rm(directory, { recursive: true, force: true })
  const copyDirectory = async (relativeDirectory: string): Promise<void> => {
    const entries = await readdir(await safePath(source, relativeDirectory))
    for (const name of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name
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
    await copyDirectory('')
    return { directory, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
