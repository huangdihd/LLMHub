import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import plugin, { gatewayEndpoint, sessionCookie } from '../plugins/plugin-studio/index.mjs'
import { Agent, checkProject } from '../plugins/plugin-studio/lib/agent.mjs'
import { TEMPLATES } from '../plugins/plugin-studio/lib/templates.mjs'
import { findCommand, flavorOf, VSCodeServer } from '../plugins/plugin-studio/lib/vscode.mjs'
import { normalizePath, Workspace } from '../plugins/plugin-studio/lib/workspace.mjs'

const temporary = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-studio-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** A route event as the plugin sees it: a readable request with headers. */
const event = (body, cookie = 'llmhub_session=session-token; other=1') => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.headers = { cookie }
  return { node: { req } }
}

function host(config) {
  const routes = new Map()
  const storage = new Map()
  const api = {
    config,
    registerRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    storage: {
      getItem: async key => structuredClone(storage.get(key) ?? null),
      setItem: async (key, value) => { storage.set(key, structuredClone(value)) },
      removeItem: async key => { storage.delete(key) }
    },
    logger: { info() {}, warn() {}, error() {} }
  }
  return { api, routes, storage, call: (route, body, cookie) => routes.get(route)(event(body, cookie)) }
}

/** An OpenAI-compatible endpoint answering from a script of assistant messages. */
async function fakeModel(t, replies) {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({ url: request.url, headers: request.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null })
    response.setHeader('content-type', 'application/json')
    if (request.url.endsWith('/models')) return response.end(JSON.stringify({ data: [{ id: 'b/model' }, { id: 'a/model' }] }))
    const message = replies.shift()
    if (!message) { response.statusCode = 500; return response.end(JSON.stringify({ error: { message: 'no more replies' } })) }
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { url: `http://127.0.0.1:${server.address().port}/api/openai`, requests }
}
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

test('file paths stay inside the project', () => {
  assert.equal(normalizePath('./ui//index.html'), 'ui/index.html')
  for (const path of ['../x', 'a/../../x', '/etc/passwd', 'node_modules/x/index.js', '.git/config', '', 'a\u0000b', 'a/ b']) {
    assert.throws(() => normalizePath(path), `${JSON.stringify(path)} is refused`)
  }
})

test('the workspace lists, edits and refuses escapes, including through symlinks', async t => {
  const root = await temporary(t)
  const workspace = new Workspace(root, 'plugin-studio')
  await workspace.create('demo', TEMPLATES.panel.files('demo', 'Demo'))
  await mkdir(join(root, 'node_modules'))
  await mkdir(join(root, 'plugin-studio'))
  await writeFile(join(root, 'plugin-studio/package.json'), JSON.stringify({ llmhub: {} }))
  await writeFile(join(root, 'package.json'), '{}')

  assert.deepEqual((await workspace.projects()).map(project => project.id), ['demo'], 'only plugin folders, never the studio itself')
  assert.deepEqual((await workspace.list('demo')).map(file => file.path), ['index.mjs', 'package.json', 'README.md', 'ui/index.html'])
  await workspace.write('demo', 'lib/util.mjs', 'export const x = 1\n')
  assert.equal(await workspace.read('demo', 'lib/util.mjs'), 'export const x = 1\n')
  await workspace.remove('demo', 'lib/util.mjs')
  await assert.rejects(workspace.read('demo', 'lib/util.mjs'), /not found/)

  const outside = await temporary(t)
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(outside, join(root, 'demo/link'))
  await symlink(join(outside, 'secret.txt'), join(root, 'demo/file-link'))
  await assert.rejects(workspace.read('demo', 'link/secret.txt'), /leaves the project/)
  await assert.rejects(workspace.write('demo', 'link/new.txt', 'x'), /leaves the project/)
  await assert.rejects(workspace.read('demo', 'file-link'), /Symbolic links/)
  await assert.rejects(workspace.read('plugin-studio', 'package.json'), /cannot edit itself/)
  await assert.rejects(workspace.create('demo', {}), /already exists/)
  await assert.rejects(workspace.create('Bad_Id', {}), /project ID/)
})

test('every template passes the project check', async t => {
  const root = await temporary(t)
  const workspace = new Workspace(root, 'plugin-studio')
  for (const [id, template] of Object.entries(TEMPLATES)) {
    await workspace.create(`t-${id}`, template.files(`t-${id}`, id))
    assert.match(await checkProject(workspace, `t-${id}`), /^No problems found/, id)
  }
  await workspace.write('t-hook', 'index.mjs', 'export default {')
  await workspace.write('t-hook', 'package.json', JSON.stringify({ name: 'x', version: '1.0.0', llmhub: { id: 'other' } }))
  const report = await checkProject(workspace, 't-hook')
  assert.match(report, /llmhub.id is "other"/)
  assert.match(report, /index\.mjs: .*SyntaxError|index\.mjs:[\s\S]*SyntaxError/)
})

test('the assistant edits files through tools and keeps the conversation', async t => {
  const root = await temporary(t)
  const workspace = new Workspace(root, 'plugin-studio')
  await workspace.create('demo', TEMPLATES.empty.files('demo', 'Demo'))
  const model = await fakeModel(t, [
    { content: 'Reading first.', tool_calls: [toolCall('1', 'read_file', { path: 'index.mjs' })] },
    { content: null, tool_calls: [toolCall('2', 'edit_file', { path: 'index.mjs', old_text: "'Started'", new_text: "'Hello'" }), toolCall('3', 'write_file', { path: '../escape.txt', content: 'x' })] },
    { tool_calls: [toolCall('4', 'check_project', {})] },
    { content: 'Done: it now logs Hello.' }
  ])
  const saved = []
  const agent = new Agent({ workspace, project: 'demo', save: async (project, messages) => saved.push({ project, messages }) })
  await agent.run({ prompt: 'Log Hello', model: 'a/model', endpoint: { url: model.url, headers: { authorization: 'Bearer key' } }, maxSteps: 10, file: 'index.mjs' })

  assert.equal(agent.error, '')
  assert.match(await workspace.read('demo', 'index.mjs'), /api\.logger\.info\('Hello'\)/)
  const tools = agent.messages.filter(message => message.role === 'tool').map(message => message.content)
  assert.match(tools[0], /setup\(api\)/)
  assert.equal(tools[1], 'Edited index.mjs')
  assert.match(tools[2], /^Error: Path not allowed/)
  assert.match(tools[3], /^No problems found/)
  assert.equal(agent.messages.at(-1).content, 'Done: it now logs Hello.')
  assert.deepEqual(agent.snapshot().changed, ['index.mjs'])
  assert.equal(saved.length, 1)

  const first = model.requests[0]
  assert.equal(first.url, '/api/openai/chat/completions')
  assert.equal(first.headers.authorization, 'Bearer key')
  assert.equal(first.body.model, 'a/model')
  assert.equal(first.body.messages[0].role, 'system')
  assert.match(first.body.messages[0].content, /index\.mjs/)
  assert.match(first.body.messages[1].content, /^Log Hello\n\n\(The user has index\.mjs open/)
  assert.ok(first.body.tools.some(tool => tool.function.name === 'edit_file'))
  // The tool result answering each call is sent back with the next request.
  assert.equal(model.requests[1].body.messages.at(-1).tool_call_id, '1')

  const tail = agent.snapshot(agent.messages.length - 1)
  assert.equal(tail.messages.length, 1)
  assert.equal(tail.end, agent.messages.length)
})

test('the assistant reports model failures and stops at the step limit', async t => {
  const root = await temporary(t)
  const workspace = new Workspace(root, 'plugin-studio')
  await workspace.create('demo', TEMPLATES.empty.files('demo', 'Demo'))
  const model = await fakeModel(t, [{ tool_calls: [toolCall('1', 'list_files', {})] }, { tool_calls: [toolCall('2', 'list_files', {})] }])
  const agent = new Agent({ workspace, project: 'demo', save: async () => {} })
  await agent.run({ prompt: 'Loop', model: 'm', endpoint: { url: model.url, headers: {} }, maxSteps: 2 })
  assert.match(agent.messages.at(-1).content, /Stopped after 2 steps/)
  await agent.run({ prompt: 'Again', model: 'm', endpoint: { url: model.url, headers: {} }, maxSteps: 2 })
  assert.match(agent.error, /model request failed \(500\): no more replies/)
  await agent.clear()
  assert.deepEqual(agent.snapshot(0).messages, [])

  // Stopped between tool calls: the skipped call still gets a result, so the next request is valid.
  const slow = await fakeModel(t, [{ tool_calls: [toolCall('a', 'list_files', {}), toolCall('b', 'list_files', {})] }])
  const stopping = new Agent({ workspace, project: 'demo', save: async () => {} })
  const execute = stopping.execute.bind(stopping)
  stopping.execute = async (...args) => { stopping.stop(); return execute(...args) }
  await stopping.run({ prompt: 'Stop me', model: 'm', endpoint: { url: slow.url, headers: {} }, maxSteps: 5 })
  assert.equal(stopping.error, 'Stopped')
  assert.deepEqual(stopping.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['a', 'b'])
  assert.match(stopping.messages.at(-1).content, /not run/)
})

test('the assistant calls the gateway with an API key, or as the signed-in dashboard user', () => {
  assert.equal(sessionCookie(event(undefined, 'a=1; llmhub_session=abc; b=2')), 'abc')
  assert.deepEqual(gatewayEndpoint({ apiKey: 'sk-1' }, event(), { PORT: '8080' }), { url: 'http://127.0.0.1:8080/api/openai', headers: { authorization: 'Bearer sk-1' } })
  assert.deepEqual(gatewayEndpoint({ gatewayUrl: 'http://gw/api/openai/' }, event(undefined, 'llmhub_session=abc; other=secret')), { url: 'http://gw/api/openai', headers: { cookie: 'llmhub_session=abc' } })
  assert.throws(() => gatewayEndpoint({}, event(undefined, '')), /API key/)
})

test('routes create plugins, edit files and run the assistant in the background', async t => {
  const root = await temporary(t)
  const model = await fakeModel(t, [{ content: 'Hi there.' }])
  const { api, call, storage } = host({ workspace: root, gatewayUrl: model.url, model: 'a/model', maxSteps: 5 })
  const cleanup = await plugin.setup(api)

  await call('POST projects', { id: 'demo', name: 'Demo', template: 'hook' })
  await assert.rejects(call('POST projects', { id: '../x' }), /project ID/)
  await assert.rejects(call('POST projects', { id: 'other', template: 'nope' }), /Unknown template/)
  const overview = await call('GET overview')
  assert.deepEqual(overview.projects.map(project => project.id), ['demo'])
  assert.equal(overview.apiKey, false)

  await call('POST files/write', { project: 'demo', path: 'lib/a.mjs', content: 'export {}\n' })
  assert.equal((await call('POST files/read', { project: 'demo', path: 'lib/a.mjs' })).content, 'export {}\n')
  assert.ok((await call('POST files/list', { project: 'demo' })).files.some(file => file.path === 'lib/a.mjs'))
  await call('POST files/delete', { project: 'demo', path: 'lib/a.mjs' })
  await assert.rejects(call('POST files/read', { project: 'demo', path: '../../etc/passwd' }), /Path not allowed/)

  assert.deepEqual((await call('GET models')).models, ['a/model', 'b/model'])
  await assert.rejects(call('POST agent/run', { project: 'demo', prompt: ' ' }), /Write a message/)
  const started = await call('POST agent/run', { project: 'demo', prompt: 'Hello' })
  assert.equal(started.running, true)
  let status
  for (let i = 0; i < 100 && (status = await call('POST agent/status', { project: 'demo', since: 0 })).running;) await new Promise(resolve => setTimeout(resolve, 10 * ++i))
  assert.deepEqual(status.messages.map(message => message.content), ['Hello', 'Hi there.'])
  assert.equal(model.requests.at(-1).headers.cookie, 'llmhub_session=session-token', 'only the session cookie is forwarded')
  assert.equal(storage.get('conversations/demo').length, 2)

  await cleanup()
})

test('a VS Code server is found, started on the plugin folder and stopped', async t => {
  const bin = await temporary(t)
  const folder = await temporary(t)
  const fake = join(bin, 'openvscode-server')
  // Like the real launchers: records its arguments and starts the actual server as a child.
  await writeFile(fake, `#!${process.execPath}
const { writeFileSync } = require('fs')
writeFileSync(${JSON.stringify(join(bin, 'args.json'))}, JSON.stringify(process.argv.slice(2)))
const server = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync(${JSON.stringify(join(bin, 'server.pid'))}, String(server.pid))
setInterval(() => {}, 1000)
`)
  await chmod(fake, 0o755)

  assert.equal(flavorOf('/opt/openvscode-server-v1.90/bin/openvscode-server'), 'openvscode-server')
  assert.equal(flavorOf('code-server'), 'code-server')
  assert.equal(flavorOf('code'), 'code')
  assert.equal(await findCommand('', { PATH: bin }), fake)
  assert.equal(await findCommand('', { PATH: folder }), null)
  assert.equal(await findCommand('relative/path', { PATH: bin }), null)

  const server = new VSCodeServer({ warn() {} })
  const status = await server.start({ command: fake, host: '127.0.0.1', port: 3999, folder })
  t.after(() => server.stop())
  assert.equal(status.running, true)
  const args = JSON.parse(await readFile(join(bin, 'args.json'), 'utf8'))
  const token = args[args.indexOf('--connection-token') + 1]
  assert.match(token, /^[0-9a-f]{48}$/)
  assert.deepEqual(args.slice(0, 4), ['--host', '127.0.0.1', '--port', '3999'])
  assert.equal(args[args.indexOf('--default-folder') + 1], folder)
  assert.equal(status.url, `http://127.0.0.1:3999/?tkn=${token}&folder=${encodeURIComponent(folder)}`)
  const serverPid = Number(await readFile(join(bin, 'server.pid'), 'utf8'))
  assert.equal(server.stop().running, false)
  assert.equal(server.status().running, false)
  // An orphan stays a zombie where PID 1 does not reap (some containers); that is stopped too.
  const alive = pid => {
    try { if (readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z')) return false } catch {}
    try { process.kill(pid, 0); return true } catch { return false }
  }
  for (let i = 0; i < 50 && alive(serverPid); i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(alive(serverPid), false, 'the server the launcher started is stopped too')

  const crashing = join(bin, 'code-server')
  await writeFile(crashing, `#!${process.execPath}\nconsole.error('port in use'); process.exit(3)\n`)
  await chmod(crashing, 0o755)
  await assert.rejects(new VSCodeServer({ warn() {} }).start({ command: crashing, host: '127.0.0.1', port: 1, folder }), /exited with code 3[\s\S]*port in use/)
})
