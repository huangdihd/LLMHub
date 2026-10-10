import assert from 'node:assert/strict'
import { access, cp, mkdir, readdir, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI } from '@google/genai'

const gateway = process.env.GATEWAY_URL || 'http://127.0.0.1:3999'
const key = 'llmhub-e2e-test-key'
const session = randomUUID()
const sessionFile = new URL(`../../.data/auth/sessions/${session}`, import.meta.url)
const installed = []
const existingEmptyStateDirectories = []
const providerName = `_e2e-plugin-${session.slice(0, 8)}`
let providerCreated = false

async function management(path, options = {}) {
  const response = await fetch(`${gateway}/api/hub/${path}`, {
    ...options, headers: { cookie: `llmhub_session=${session}`, ...options.headers }
  })
  const text = await response.text()
  assert.ok(response.ok, `${options.method || 'GET'} ${path}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : undefined
}
const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const openai = new OpenAI({ baseURL: `${gateway}/api/openai`, apiKey: key, maxRetries: 0 })
const claude = new Anthropic({ baseURL: `${gateway}/api/claude`, apiKey: key, maxRetries: 0 })
const gemini = new GoogleGenAI({ apiKey: key, httpOptions: { baseUrl: `${gateway}/api/gemini` } })
const model = `${providerName}/echo`

async function exercise(expectHook) {
  function check(text) {
    assert.ok(text.includes('echo-input'), text)
    assert.equal(text.includes('E2E_PLUGIN_INSTRUCTION'), expectHook, text)
  }
  const request = { model, messages: [{ role: 'user', content: 'echo-input' }] }
  const response = await openai.chat.completions.create(request)
  check(response.choices[0].message.content)
  let text = ''
  for await (const chunk of await openai.chat.completions.create({ ...request, stream: true })) text += chunk.choices[0]?.delta?.content || ''
  check(text)
  const message = await claude.messages.create({ ...request, max_tokens: 256 })
  check(message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
  text = ''
  for await (const event of await claude.messages.create({ ...request, max_tokens: 256, stream: true })) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') text += event.delta.text
  }
  check(text)
  const content = await gemini.models.generateContent({ model, contents: 'echo-input' })
  check(content.text)
  text = ''
  for await (const chunk of await gemini.models.generateContentStream({ model, contents: 'echo-input' })) text += chunk.text || ''
  check(text)
}

try {
  await mkdir(new URL('../../.data/auth/sessions/', import.meta.url), { recursive: true })
  await writeFile(sessionFile, JSON.stringify({ expires_at: Date.now() + 300_000 }))
  const before = await management('plugins')
  for (const [id, protocol] of [
    ['provider-openai', 'openai'], ['provider-claude', 'claude'], ['provider-gemini', 'gemini'],
    ['provider-codex', 'codex-subscription'], ['provider-claude-subscription', 'claude-subscription'],
    ['provider-antigravity', 'antigravity-subscription']
  ]) {
    const builtin = before.find(plugin => plugin.id === id)
    assert.equal(builtin?.builtin, true)
    assert.equal(builtin.enabled, true)
    assert.deepEqual(builtin.providers, [protocol])
    for (const [method, suffix] of [['POST', '/disable'], ['DELETE', '']]) {
      const response = await fetch(`${gateway}/api/hub/plugins/${id}${suffix}`, {
        method, headers: { cookie: `llmhub_session=${session}` }
      })
      assert.equal(response.ok, false, `${id} must remain read-only`)
    }
  }
  for (const [family, protocols] of [
    ['openai', ['openai-chat', 'openai-completion', 'openai-responses']],
    ['claude', ['claude-messages', 'claude-completion']],
    ['gemini', ['gemini-generate']]
  ]) {
    const id = `ingress-${family}`
    const builtin = before.find(plugin => plugin.id === id)
    assert.equal(builtin?.builtin, true)
    assert.equal(builtin.enabled, true)
    assert.deepEqual(builtin.ingresses, [family])
    assert.deepEqual(builtin.protocols, protocols)
    assert.deepEqual(builtin.providers, [])
    assert.deepEqual(builtin.hooks, [])
    for (const [method, suffix] of [['POST', '/enable'], ['POST', '/disable'], ['DELETE', '']]) {
      const response = await fetch(`${gateway}/api/hub/plugins/${id}${suffix}`, {
        method, headers: { cookie: `llmhub_session=${session}` }
      })
      assert.equal(response.ok, false, `${id} must remain read-only`)
    }
  }
  console.log('  ok - three builtin ingress plugins retain protocol IDs and reject lifecycle mutations')
  // Missing session probes exercise built layer routes without contacting OAuth upstreams.
  for (const [flow, action, label] of [['codex', 'poll', 'ChatGPT'], ['claude', 'complete', 'Claude'], ['antigravity', 'complete', 'Antigravity']]) {
    const response = await fetch(`${gateway}/api/hub/providers/${flow}-login/${session}/${action}`, {
      ...json('POST', {}), headers: { cookie: `llmhub_session=${session}`, 'content-type': 'application/json' }
    })
    assert.equal(response.status, 404)
    assert.equal((await response.json()).message, `${label} login session not found`)
  }
  console.log('  ok - six builtin providers are listed read-only and migrated login routes are mounted')
  // The retired endpoint is an ordinary unknown route, not a compatibility API.
  const retired = await fetch(`${gateway}/api/hub/plugins/install`, {
    method: 'POST', headers: { cookie: `llmhub_session=${session}` }
  })
  assert.equal(retired.status, 404)
  assert.equal((await retired.json()).message, 'Plugin endpoint not found')
  for (const [directory, id] of [['echo', 'example-echo'], ['system-prompt', 'example-system-prompt']]) {
    assert.ok(!before.some(plugin => plugin.id === id), `Refusing to replace existing ${id}`)
    const destination = new URL(`../../.data/plugins/${id}/`, import.meta.url)
    await assert.rejects(access(destination), { code: 'ENOENT' })
    const stateDirectory = new URL(`../../.data/runtime-plugins/${id}/`, import.meta.url)
    try {
      assert.deepEqual(await readdir(stateDirectory), [], `Refusing to replace existing ${id} state`)
      existingEmptyStateDirectories.push(stateDirectory)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    installed.push(id)
    await cp(new URL(`../../examples/plugins/${directory}/`, import.meta.url), destination, { recursive: true, errorOnExist: true, force: false })
    await management('plugins/scan', { method: 'POST' })
    await management(`plugins/${id}/enable`, { method: 'POST' })
  }
  await management('plugins/example-system-prompt/config', json('PUT', { suffix: 'E2E_PLUGIN_INSTRUCTION', enabled: true, token: 'e2e-secret-value' }))
  const configuration = await management('plugins/example-system-prompt/config')
  assert.ok(!JSON.stringify(configuration).includes('e2e-secret-value'))
  assert.equal((await management('plugins/example-echo/api/status')).ready, true)
  await management('providers', json('POST', {
    name: providerName, protocol: 'example-echo:echo',
    connection: { extra: { prefix: 'prefix:' } }, enabled: true,
    use_custom_models: true, models: [{ id: 'echo', display_name: 'Echo' }]
  }))
  providerCreated = true
  await exercise(true)
  console.log('  ok - runtime echo + request hook across three protocols, stream and non-stream')
  await management('plugins/example-system-prompt/disable', { method: 'POST' })
  await exercise(false)
  console.log('  ok - disabled hook has no effect across all six ingress cases')
  await management('plugins/example-echo/reload', { method: 'POST' })
  await exercise(false)
  await management('plugins/example-echo/disable', { method: 'POST' })
  await assert.rejects(openai.chat.completions.create({ model, messages: [{ role: 'user', content: 'echo-input' }] }))
  const healthy = await openai.chat.completions.create({ model: '_e2e-openai/text', messages: [{ role: 'user', content: 'hello' }] })
  assert.ok(healthy.choices[0].message.content)
  console.log('  ok - disabled provider is unavailable; built-in gateway remains healthy')
} finally {
  try {
    const cleanupResults = await Promise.allSettled([
      ...(providerCreated ? [management(`providers/${providerName}`, { method: 'DELETE' })] : []),
      ...installed.reverse().map(id => management(`plugins/${id}`, { method: 'DELETE' }))
    ])
    const failures = cleanupResults.filter(result => result.status === 'rejected')
    assert.equal(failures.length, 0, `Plugin fixture cleanup failed: ${failures.map(result => result.reason).join('; ')}`)
    const remaining = await management('plugins')
    for (const id of installed) {
      assert.ok(!remaining.some(plugin => plugin.id === id), `Plugin still listed after uninstall: ${id}`)
      await assert.rejects(access(new URL(`../../.data/plugins/${id}`, import.meta.url)), { code: 'ENOENT' })
      await assert.rejects(access(new URL(`../../.data/runtime-plugins/${id}/state`, import.meta.url)), { code: 'ENOENT' })
    }
    console.log('  ok - plugin directories and persisted state removed')
  } finally {
    // These paths were checked absent before copying; remove partial fixtures even
    // if scan/activation failed before the manager could register them.
    try {
      await Promise.all(installed.flatMap(id => [
        rm(new URL(`../../.data/plugins/${id}/`, import.meta.url), { recursive: true, force: true }),
        rm(new URL(`../../.data/runtime-plugins/${id}/`, import.meta.url), { recursive: true, force: true })
      ]))
      await Promise.all(existingEmptyStateDirectories.map(directory => mkdir(directory, { recursive: true })))
    } finally {
      await rm(sessionFile, { force: true })
    }
  }
}
