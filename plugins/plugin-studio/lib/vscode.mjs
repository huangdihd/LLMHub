import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, join } from 'node:path'

/**
 * Supported VS Code servers. Each one serves the full editor in a browser tab;
 * the dashboard's panel sandbox cannot frame it, so it opens beside the dashboard.
 */
const FLAVORS = {
  'openvscode-server': {
    label: 'OpenVSCode Server',
    args: ({ host, port, token, folder }) => ['--host', host, '--port', String(port), '--connection-token', token, '--default-folder', folder, '--telemetry-level', 'off'],
    env: () => ({}),
    query: ({ token, folder }) => `?tkn=${encodeURIComponent(token)}&folder=${encodeURIComponent(folder)}`,
    password: false
  },
  'code-server': {
    label: 'code-server',
    args: ({ host, port, folder }) => ['--bind-addr', `${host}:${port}`, '--auth', 'password', '--disable-telemetry', '--disable-update-check', folder],
    env: ({ token }) => ({ PASSWORD: token }),
    query: ({ folder }) => `?folder=${encodeURIComponent(folder)}`,
    password: true
  },
  code: {
    label: 'VS Code (serve-web)',
    args: ({ host, port, token }) => ['serve-web', '--host', host, '--port', String(port), '--connection-token', token, '--accept-server-license-terms'],
    env: () => ({}),
    query: ({ token, folder }) => `?tkn=${encodeURIComponent(token)}&folder=${encodeURIComponent(folder)}`,
    password: false
  }
}
const SEARCH = ['openvscode-server', 'code-server', 'code']

export function flavorOf(command) {
  const name = basename(command).replace(/\.(cmd|exe|sh)$/i, '')
  return Object.hasOwn(FLAVORS, name) ? name : name.includes('openvscode') ? 'openvscode-server' : name.includes('code-server') ? 'code-server' : 'code'
}

async function executable(path) {
  try { await access(path, 1); return true } catch { return false }
}

export async function findCommand(configured, env = process.env) {
  if (configured) {
    if (isAbsolute(configured)) return (await executable(configured)) ? configured : null
    if (configured.includes('/') || configured.includes('\\')) return null
  }
  for (const name of configured ? [configured] : SEARCH) {
    for (const folder of (env.PATH || '').split(delimiter).filter(Boolean)) {
      const candidate = join(folder, name)
      if (await executable(candidate)) return candidate
    }
  }
  return null
}

export class VSCodeServer {
  constructor(logger) {
    this.logger = logger
    this.child = null
    this.state = null
    this.output = []
  }

  status() {
    if (!this.state) return { running: false, output: this.output.join('') }
    const { flavor, host, port, token, folder, publicUrl, startedAt } = this.state
    const definition = FLAVORS[flavor]
    const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
    const base = (publicUrl || `http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${port}`).replace(/\/+$/, '')
    return {
      running: true, flavor: definition.label, startedAt, folder,
      url: `${base}/${definition.query({ token, folder })}`,
      password: definition.password ? token : undefined,
      output: this.output.join('')
    }
  }

  /** @param {{ command: string, host: string, port: number, folder: string, publicUrl?: string }} options */
  async start({ command, host, port, folder, publicUrl }) {
    if (this.child) return this.status()
    const flavor = flavorOf(command)
    const definition = FLAVORS[flavor]
    const token = randomBytes(24).toString('hex')
    this.output = []
    const child = spawn(command, definition.args({ host, port, token, folder }), {
      cwd: folder, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      // The commands are launcher scripts that start the real server as a child;
      // a process group of its own lets stop() end both.
      detached: process.platform !== 'win32',
      env: { ...process.env, ...definition.env({ token }) }
    })
    const record = chunk => {
      this.output.push(String(chunk))
      // Keep the tail; it is only for diagnosing a server that will not start.
      while (this.output.join('').length > 8000) this.output.shift()
    }
    child.stdout.on('data', record)
    child.stderr.on('data', record)
    this.child = child
    this.state = { flavor, host, port, token, folder, publicUrl, startedAt: Date.now() }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1500)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`${definition.label} exited with code ${code}. ${this.output.join('').slice(-600)}`)) })
    }).catch(error => {
      this.child = null
      this.state = null
      throw error
    })
    child.once('exit', code => {
      if (this.child !== child) return
      this.logger.warn(`${definition.label} exited with code ${code}`)
      this.child = null
      this.state = null
    })
    return this.status()
  }

  stop() {
    const child = this.child
    this.child = null
    this.state = null
    if (child && child.exitCode === null) terminate(child)
    return { running: false }
  }
}

function terminate(child) {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    return
  }
  try { process.kill(-child.pid, 'SIGTERM') }
  catch { child.kill('SIGTERM') }
}
