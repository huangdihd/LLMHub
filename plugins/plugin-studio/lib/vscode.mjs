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
    password: false,
    extensions: true
  },
  'code-server': {
    label: 'code-server',
    args: ({ host, port, folder }) => ['--bind-addr', `${host}:${port}`, '--auth', 'password', '--disable-telemetry', '--disable-update-check', folder],
    env: ({ token }) => ({ PASSWORD: token }),
    query: ({ folder }) => `?folder=${encodeURIComponent(folder)}`,
    password: true,
    extensions: true
  },
  code: {
    label: 'VS Code (serve-web)',
    args: ({ host, port, token }) => ['serve-web', '--host', host, '--port', String(port), '--connection-token', token, '--accept-server-license-terms'],
    env: () => ({}),
    query: ({ token, folder }) => `?tkn=${encodeURIComponent(token)}&folder=${encodeURIComponent(folder)}`,
    password: false,
    // serve-web downloads its server on first start; extensions are installed from its own UI.
    extensions: false
  }
}
const INSTALL_TIMEOUT = 5 * 60 * 1000
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
    this.phase = ''
    this.error = ''
    this.warning = ''
    /** Bumped by stop(), so a launch still preparing does not start a server afterwards. */
    this.generation = 0
  }

  record(chunk) {
    this.output.push(String(chunk))
    // Keep the tail; it is only for diagnosing a server that will not start.
    while (this.output.join('').length > 8000) this.output.shift()
  }

  status() {
    if (!this.state) return { running: false, phase: this.phase, error: this.error, warning: this.warning, output: this.output.join('') }
    const { flavor, host, port, token, folder, publicUrl, startedAt } = this.state
    const definition = FLAVORS[flavor]
    const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
    const base = (publicUrl || `http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${port}`).replace(/\/+$/, '')
    return {
      running: true, phase: 'running', warning: this.warning, flavor: definition.label, startedAt, folder,
      url: `${base}/${definition.query({ token, folder })}`,
      password: definition.password ? token : undefined,
      output: this.output.join('')
    }
  }

  /**
   * Starts in the background, because installing an extension can take minutes;
   * poll status() for the phase. `prepare` runs first and may return a warning.
   * @param {{ command: string, host: string, port: number, folder: string, publicUrl?: string,
   *   env?: Record<string, string>, extension?: string, prepare?: () => Promise<string | void> }} options
   */
  start(options) {
    if (!this.child && !this.phase) {
      this.output = []
      this.error = ''
      this.warning = ''
      this.launch(options)
        .catch(error => { this.error = error.message })
        .finally(() => { this.phase = '' })
    }
    return this.status()
  }

  async launch({ command, host, port, folder, publicUrl, env = {}, extension, prepare }) {
    const flavor = flavorOf(command)
    const definition = FLAVORS[flavor]
    const generation = this.generation
    this.phase = 'preparing'
    const warnings = []
    if (prepare) {
      const warning = await prepare().catch(error => error.message)
      if (warning) warnings.push(warning)
    }
    if (extension && definition.extensions) {
      this.phase = 'installing'
      const installed = await run(command, ['--list-extensions'], 30000).catch(() => '')
      if (!installed.toLowerCase().split(/\s+/).includes(extension.toLowerCase())) {
        try { this.record(await run(command, ['--install-extension', extension], INSTALL_TIMEOUT)) }
        catch (error) { warnings.push(`Could not install ${extension}: ${error.message.slice(-300)}`) }
      }
    }
    this.warning = warnings.join(' ')
    if (generation !== this.generation) return
    this.phase = 'starting'
    const token = randomBytes(24).toString('hex')
    const child = spawn(command, definition.args({ host, port, token, folder }), {
      cwd: folder, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      // The commands are launcher scripts that start the real server as a child;
      // a process group of its own lets stop() end both.
      detached: process.platform !== 'win32',
      env: { ...process.env, ...env, ...definition.env({ token }) }
    })
    const record = chunk => this.record(chunk)
    child.stdout.on('data', record)
    child.stderr.on('data', record)
    // stop() during the readiness wait must still end this process.
    this.child = child
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1500)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`${definition.label} exited with code ${code}. ${this.output.join('').slice(-600)}`)) })
    }).catch(error => {
      // Stopped while starting is not a failure.
      if (this.child !== child) return
      this.child = null
      throw error
    })
    if (this.child !== child) return
    this.state = { flavor, host, port, token, folder, publicUrl, startedAt: Date.now() }
    child.once('exit', code => {
      if (this.child !== child) return
      this.logger.warn(`${definition.label} exited with code ${code}`)
      this.child = null
      this.state = null
    })
  }

  stop() {
    this.generation++
    const child = this.child
    this.child = null
    this.state = null
    if (child && child.exitCode === null) terminate(child)
    return { running: false }
  }
}

function run(command, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(String(stdout)))
  })
}

function terminate(child) {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    return
  }
  try { process.kill(-child.pid, 'SIGTERM') }
  catch { child.kill('SIGTERM') }
}
