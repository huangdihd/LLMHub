import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** Same rule the plugin manager applies to directory names it scans. */
export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,40}$/
const SEGMENT = /^[a-zA-Z0-9_@+=,~-][a-zA-Z0-9_.@+=,~-]{0,127}$/
const HIDDEN = new Set(['node_modules', '.git'])
export const MAX_FILE_BYTES = 512 * 1024
const MAX_LISTED = 2000

export class WorkspaceError extends Error {}

/**
 * A file path inside a project, given by the panel or the model. Only plain
 * relative paths: no traversal, no absolute paths, nothing under node_modules
 * or .git, and every segment from a conservative character set.
 */
export function normalizePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512) throw new WorkspaceError('Invalid file path')
  const normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new WorkspaceError(`Path not allowed: ${value}`)
  const segments = normalized.split('/').filter(segment => segment && segment !== '.')
  if (!segments.length) throw new WorkspaceError('Invalid file path')
  for (const segment of segments) {
    if (segment === '..' || !SEGMENT.test(segment) || HIDDEN.has(segment)) throw new WorkspaceError(`Path not allowed: ${value}`)
  }
  return segments.join('/')
}

export function validateProjectId(id) {
  if (typeof id !== 'string' || !PROJECT_ID.test(id) || id === 'llmhub') throw new WorkspaceError('A project ID is 2–41 lowercase letters, digits or dashes, starting with a letter or digit')
  return id
}

export class Workspace {
  /** @param {string} root the runtime plugin directory, normally `.data/plugins` */
  constructor(root, selfId) {
    this.root = resolve(root)
    this.selfId = selfId
  }

  async projects() {
    let items = []
    try { items = await readdir(this.root, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const projects = []
    for (const item of items) {
      if (!item.isDirectory() || !PROJECT_ID.test(item.name) || item.name === this.selfId) continue
      const manifest = await this.manifest(item.name).catch(() => null)
      if (manifest) projects.push(manifest)
    }
    return projects.sort((a, b) => a.id.localeCompare(b.id))
  }

  async manifest(id) {
    const directory = await this.projectDirectory(id)
    for (const name of ['package.json', 'plugin.json']) {
      let text
      try { text = await readFile(join(directory, name), 'utf8') } catch { continue }
      try {
        const data = JSON.parse(text)
        const meta = name === 'package.json' ? data.llmhub : data
        if (!meta || typeof meta !== 'object') continue
        return { id, name: String(meta.name || data.name || id), version: String(data.version || ''), description: String(data.description || ''), manifest: name }
      } catch {
        return { id, name: id, version: '', description: '', manifest: name, invalid: true }
      }
    }
    return null
  }

  async projectDirectory(id) {
    validateProjectId(id)
    if (id === this.selfId) throw new WorkspaceError('Plugin Studio cannot edit itself')
    return join(this.root, id)
  }

  /** Resolves a file and refuses anything that leaves the project, including through symlinks. */
  async resolveFile(id, path) {
    const directory = await this.projectDirectory(id)
    const file = join(directory, normalizePath(path))
    const base = await realpath(directory).catch(() => { throw new WorkspaceError(`Project not found: ${id}`) })
    let ancestor = dirname(file)
    for (;;) {
      try {
        const real = await realpath(ancestor)
        if (real !== base && !real.startsWith(base + sep)) throw new WorkspaceError('Path leaves the project')
        break
      } catch (error) {
        if (error instanceof WorkspaceError) throw error
        if (ancestor === directory) throw new WorkspaceError(`Project not found: ${id}`)
        ancestor = dirname(ancestor)
      }
    }
    try {
      if ((await lstat(file)).isSymbolicLink()) throw new WorkspaceError('Symbolic links are not edited')
    } catch (error) { if (error instanceof WorkspaceError) throw error }
    return file
  }

  async list(id) {
    const directory = await this.projectDirectory(id)
    const files = []
    const walk = async folder => {
      let items
      try { items = await readdir(folder, { withFileTypes: true }) }
      catch (error) { if (error.code === 'ENOENT' && folder === directory) throw new WorkspaceError(`Project not found: ${id}`); throw error }
      items.sort((a, b) => a.name.localeCompare(b.name))
      for (const item of items) {
        if (files.length >= MAX_LISTED) return
        if (HIDDEN.has(item.name) || !SEGMENT.test(item.name)) continue
        const full = join(folder, item.name)
        if (item.isDirectory()) await walk(full)
        else if (item.isFile()) {
          const { size } = await lstat(full)
          files.push({ path: relative(directory, full).split(sep).join('/'), size })
        }
      }
    }
    await walk(directory)
    return files
  }

  async read(id, path) {
    const file = await this.resolveFile(id, path)
    let info
    try { info = await lstat(file) } catch { throw new WorkspaceError(`File not found: ${path}`) }
    if (!info.isFile()) throw new WorkspaceError(`Not a file: ${path}`)
    if (info.size > MAX_FILE_BYTES) throw new WorkspaceError(`File is larger than ${MAX_FILE_BYTES / 1024} KiB: ${path}`)
    const buffer = await readFile(file)
    if (buffer.includes(0)) throw new WorkspaceError(`Binary file: ${path}`)
    return buffer.toString('utf8')
  }

  async write(id, path, content) {
    if (typeof content !== 'string') throw new WorkspaceError('File content must be text')
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new WorkspaceError(`File is larger than ${MAX_FILE_BYTES / 1024} KiB`)
    const file = await this.resolveFile(id, path)
    await mkdir(dirname(file), { recursive: true })
    // mkdir may have created directories; check the final location again.
    await this.resolveFile(id, path)
    await writeFile(file, content)
  }

  async remove(id, path) {
    const file = await this.resolveFile(id, path)
    try { if (!(await lstat(file)).isFile()) throw new WorkspaceError(`Not a file: ${path}`) }
    catch (error) { if (error instanceof WorkspaceError) throw error; throw new WorkspaceError(`File not found: ${path}`) }
    await rm(file)
  }

  async create(id, files) {
    const directory = await this.projectDirectory(id)
    try { await lstat(directory); throw new WorkspaceError(`A plugin folder named ${id} already exists`) }
    catch (error) { if (error instanceof WorkspaceError) throw error }
    await mkdir(directory, { recursive: true })
    for (const [path, content] of Object.entries(files)) await this.write(id, path, content)
  }
}
