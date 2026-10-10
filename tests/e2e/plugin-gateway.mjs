import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { createServer } from 'node:net'

// Isolate package operations, registry settings and plugin state from the live gateway.
export async function createPluginGateway() {
  const directory = await mkdtemp(join(tmpdir(), 'llmhub-e2e-plugin-'))
  const session = randomUUID()
  let child
  let output = ''
  async function close() {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
    await rm(directory, { recursive: true, force: true })
  }
  try {
    const reservation = createServer()
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
    const port = reservation.address().port
    await new Promise(resolve => reservation.close(resolve))
    const gateway = `http://127.0.0.1:${port}`
    await mkdir(join(directory, '.data/auth/sessions'), { recursive: true })
    await writeFile(join(directory, '.data/auth/password'), JSON.stringify({ hash: 'unused-fixture-hash', salt: 'unused-fixture-salt' }))
    await writeFile(join(directory, '.data/auth/sessions', session), JSON.stringify({ expires_at: Date.now() + 300_000 }))
    child = spawn(process.execPath, [fileURLToPath(new URL('../../.output/server/index.mjs', import.meta.url))], {
      cwd: directory, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    async function request(path, options = {}) {
      return fetch(`${gateway}/api/hub/plugins${path}`, {
        ...options, headers: { cookie: `llmhub_session=${session}`, ...options.headers }
      })
    }
    for (let attempt = 0; attempt < 120; attempt++) {
      assert.equal(child.exitCode, null, `Isolated gateway exited: ${output}`)
      try {
        if ((await request('')).ok) return { request, directory, close }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error(`Isolated gateway did not become ready: ${output}`)
  } catch (error) {
    await close()
    throw error
  }
}
