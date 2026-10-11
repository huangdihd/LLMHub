import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { parse } from 'yaml'
import plugin, { gatewayUrl, listModels } from '../plugins/plugin-studio/index.mjs'
import { continueConfig, GUIDE } from '../plugins/plugin-studio/lib/continue.mjs'
import { TEMPLATES } from '../plugins/plugin-studio/lib/templates.mjs'
import { findCommand, flavorOf, VSCodeServer } from '../plugins/plugin-studio/lib/vscode.mjs'
import { Workspace } from '../plugins/plugin-studio/lib/workspace.mjs'

const temporary = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-studio-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
const event = body => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.headers = {}
  return { node: { req } }
}
const wait = async (condition, message) => {
  for (let i = 0; i < 200 && !(await condition()); i++) await new Promise(resolve => setTimeout(resolve, 25))
  assert.ok(await condition(), message)
}

async function fakeGateway(t) {
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: [{ id: 'b/model' }, { id: 'a/model' }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { url: `http://127.0.0.1:${server.address().port}/api/openai`, requests }
}

/** Behaves like the real launchers: handles extension commands, else starts the actual server as a child. */
async function fakeLauncher(directory, name = 'openvscode-server') {
  const file = join(directory, name)
  await writeFile(file, `#!${process.execPath}
const { appendFileSync, writeFileSync, existsSync } = require('fs')
const at = name => ${JSON.stringify(directory)} + '/' + name
const args = process.argv.slice(2)
appendFileSync(at('calls.log'), JSON.stringify(args) + '\\n')
if (args[0] === '--list-extensions') { console.log(existsSync(at('installed')) ? 'continue.continue' : 'other.extension'); process.exit(0) }
if (args[0] === '--install-extension') { writeFileSync(at('installed'), ''); process.exit(0) }
writeFileSync(at('env.json'), JSON.stringify({ CONTINUE_GLOBAL_DIR: process.env.CONTINUE_GLOBAL_DIR }))
const server = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync(at('server.pid'), String(server.pid))
setInterval(() => {}, 1000)
`)
  await chmod(file, 0o755)
  return file
}
// An orphan stays a zombie where PID 1 does not reap (some containers); that is stopped too.
const alive = pid => {
  try { if (readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z')) return false } catch {}
  try { process.kill(pid, 0); return true } catch { return false }
}

test('plugins are created from templates that pass a syntax check', async t => {
  const root = await temporary(t)
  const workspace = new Workspace(root, 'plugin-studio')
  for (const [id, template] of Object.entries(TEMPLATES)) {
    await workspace.create(`t-${id}`, template.files(`t-${id}`, id))
    const manifest = JSON.parse(await readFile(join(root, `t-${id}/package.json`), 'utf8'))
    assert.equal(manifest.llmhub.id, `t-${id}`, 'the ID matches the folder, as the plugin manager requires')
    execFileSync(process.execPath, ['--check', join(root, `t-${id}/index.mjs`)])
  }
  await mkdir(join(root, 'node_modules'))
  await mkdir(join(root, 'plugin-studio'))
  await writeFile(join(root, 'plugin-studio/package.json'), JSON.stringify({ llmhub: {} }))
  assert.deepEqual((await workspace.projects()).map(project => project.id), ['t-empty', 't-hook', 't-panel'], 'never the studio itself')
  await assert.rejects(workspace.create('t-hook', {}), /already exists/)
  await assert.rejects(workspace.create('../x', {}), /plugin ID/)
  assert.throws(() => workspace.directory('plugin-studio'), /cannot edit itself/)
})

test('Continue is configured with every model of the API key and the authoring guide', async t => {
  const config = parse(continueConfig({ models: ['a/model', 'b "odd"\nmodel'], apiBase: 'http://127.0.0.1:3000/api/openai', apiKey: 'sk-1' }))
  assert.equal(config.schema, 'v1')
  assert.deepEqual(config.models.map(model => model.model), ['a/model', 'b "odd"\nmodel'])
  assert.deepEqual(config.models[0], { name: 'a/model', provider: 'openai', model: 'a/model', apiBase: 'http://127.0.0.1:3000/api/openai', apiKey: 'sk-1', roles: ['chat', 'edit', 'apply'], capabilities: ['tool_use'] })
  assert.deepEqual(config.rules, [GUIDE])
  assert.deepEqual(parse(continueConfig({ models: [], apiBase: 'x', apiKey: 'y' })).models, [])

  const gateway = await fakeGateway(t)
  assert.deepEqual(await listModels(gateway.url, 'sk-1', 'b/model'), ['b/model', 'a/model'])
  assert.equal(gateway.requests[0].authorization, 'Bearer sk-1')
  assert.equal(gatewayUrl({}, { PORT: '8080' }), 'http://127.0.0.1:8080/api/openai')
  assert.equal(gatewayUrl({ gatewayUrl: 'http://gw/api/openai/' }), 'http://gw/api/openai')
})

test('a VS Code server is found, gets Continue, starts on the plugin folder and stops completely', async t => {
  const bin = await temporary(t)
  const folder = await temporary(t)
  const launcher = await fakeLauncher(bin)
  assert.equal(flavorOf('/opt/openvscode-server-v1.90/bin/openvscode-server'), 'openvscode-server')
  assert.equal(flavorOf('code-server'), 'code-server')
  assert.equal(flavorOf('code'), 'code')
  assert.equal(await findCommand('', { PATH: bin }), launcher)
  assert.equal(await findCommand('', { PATH: folder }), null)
  assert.equal(await findCommand('relative/path', { PATH: bin }), null)

  const server = new VSCodeServer({ warn() {} })
  t.after(() => server.stop())
  let prepared = 0
  const options = { command: launcher, host: '127.0.0.1', port: 3999, folder, extension: 'Continue.continue', env: { CONTINUE_GLOBAL_DIR: '/tmp/continue' }, prepare: async () => { prepared++; return 'note' } }
  assert.equal(server.start(options).running, false)
  await wait(() => server.status().running, 'the server starts in the background')
  const status = server.status()
  assert.equal(status.warning, 'note')
  assert.equal(prepared, 1)

  const calls = (await readFile(join(bin, 'calls.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(calls.slice(0, 2), [['--list-extensions'], ['--install-extension', 'Continue.continue']])
  const args = calls[2]
  const token = args[args.indexOf('--connection-token') + 1]
  assert.match(token, /^[0-9a-f]{48}$/)
  assert.deepEqual(args.slice(0, 4), ['--host', '127.0.0.1', '--port', '3999'])
  assert.equal(args[args.indexOf('--default-folder') + 1], folder)
  assert.equal(status.url, `http://127.0.0.1:3999/?tkn=${token}&folder=${encodeURIComponent(folder)}`)
  assert.deepEqual(JSON.parse(await readFile(join(bin, 'env.json'), 'utf8')), { CONTINUE_GLOBAL_DIR: '/tmp/continue' })

  const serverPid = Number(await readFile(join(bin, 'server.pid'), 'utf8'))
  assert.equal(server.stop().running, false)
  await wait(() => !alive(serverPid), 'the server the launcher started is stopped too')

  // Installed already: no second installation.
  server.start(options)
  await wait(() => server.status().running, 'restarts')
  server.stop()
  const again = (await readFile(join(bin, 'calls.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)[0])
  assert.equal(again.filter(arg => arg === '--install-extension').length, 1)

  const crashing = join(bin, 'code-server')
  await writeFile(crashing, `#!${process.execPath}\nif (process.argv[2] === '--list-extensions') process.exit(0)\nconsole.error('port in use'); process.exit(3)\n`)
  await chmod(crashing, 0o755)
  const failing = new VSCodeServer({ warn() {} })
  failing.start({ command: crashing, host: '127.0.0.1', port: 1, folder })
  await wait(() => failing.status().error, 'reports a server that exits')
  assert.match(failing.status().error, /exited with code 3[\s\S]*port in use/)
})

test('routes list and create plugins and start VS Code with Continue pointed at the gateway', async t => {
  const root = await temporary(t)
  const bin = await temporary(t)
  const gateway = await fakeGateway(t)
  const launcher = await fakeLauncher(bin)
  const routes = new Map()
  const api = {
    config: { workspace: join(root, 'plugins'), apiKey: 'sk-1', model: 'b/model', gatewayUrl: gateway.url, vscodeCommand: launcher, vscodePort: 3998 },
    registerRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    logger: { info() {}, warn() {}, error() {} }
  }
  const call = (route, body) => routes.get(route)(event(body))
  const cleanup = await plugin.setup(api)

  await call('POST projects', { id: 'demo', name: 'Demo', template: 'panel' })
  await assert.rejects(call('POST projects', { id: 'other', template: 'nope' }), /Unknown template/)
  const overview = await call('GET overview')
  assert.deepEqual(overview.projects.map(project => project.name), ['Demo'])
  assert.equal(overview.apiKey, true)

  await call('POST vscode/start', { project: 'demo' })
  await wait(async () => (await call('GET vscode')).running, 'VS Code starts')
  assert.equal((await call('GET vscode')).folder, join(root, 'plugins/demo'))
  const directory = JSON.parse(await readFile(join(bin, 'env.json'), 'utf8')).CONTINUE_GLOBAL_DIR
  assert.equal(directory, join(root, 'plugin-studio/continue'), 'outside the scanned plugin folder')
  const config = parse(await readFile(join(directory, 'config.yaml'), 'utf8'))
  assert.deepEqual(config.models.map(model => model.model), ['b/model', 'a/model'])
  assert.equal(config.models[0].apiBase, gateway.url)
  await assert.rejects(call('POST vscode/start', { project: '../x' }), /plugin ID/)
  await cleanup()
  assert.equal((await call('GET vscode')).running, false)
})
