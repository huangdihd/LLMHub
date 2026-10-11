import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** Same rule the plugin manager applies to directory names it scans. */
export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,40}$/

export class WorkspaceError extends Error {}

export function validateProjectId(id) {
  if (typeof id !== 'string' || !PROJECT_ID.test(id) || id === 'llmhub') throw new WorkspaceError('A plugin ID is 2–41 lowercase letters, digits or dashes, starting with a letter or digit')
  return id
}

/** The runtime plugin folder: lists the plugins in it and creates new ones from templates. */
export class Workspace {
  constructor(root, selfId) {
    this.root = resolve(root)
    this.selfId = selfId
  }

  directory(id) {
    validateProjectId(id)
    if (id === this.selfId) throw new WorkspaceError('Plugin Studio cannot edit itself')
    return join(this.root, id)
  }

  async projects() {
    let items = []
    try { items = await readdir(this.root, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const projects = []
    for (const item of items) {
      if (!item.isDirectory() || !PROJECT_ID.test(item.name) || item.name === this.selfId) continue
      const project = await this.describe(item.name)
      if (project) projects.push(project)
    }
    return projects.sort((a, b) => a.id.localeCompare(b.id))
  }

  async describe(id) {
    for (const name of ['package.json', 'plugin.json']) {
      let text
      try { text = await readFile(join(this.directory(id), name), 'utf8') } catch { continue }
      try {
        const data = JSON.parse(text)
        const meta = name === 'package.json' ? data.llmhub : data
        if (meta && typeof meta === 'object') return { id, name: String(meta.name || data.name || id), version: String(data.version || ''), description: String(data.description || '') }
      } catch {
        return { id, name: id, version: '', description: '', invalid: true }
      }
    }
    return null
  }

  /** @param {Record<string, string>} files relative paths from a template, never user input */
  async create(id, files) {
    const directory = this.directory(id)
    try { await lstat(directory); throw new WorkspaceError(`A plugin folder named ${id} already exists`) }
    catch (error) { if (error instanceof WorkspaceError) throw error }
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(directory, path)), { recursive: true })
      await writeFile(join(directory, path), content)
    }
  }
}
