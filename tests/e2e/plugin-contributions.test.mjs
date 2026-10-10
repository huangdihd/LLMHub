import assert from 'node:assert/strict'
import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import { createPluginGateway } from './plugin-gateway.mjs'

const fixture = await createPluginGateway()
const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
async function management(path, options = {}) {
  const response = await fetch(`${fixture.gateway}/api/hub/${path}`, {
    ...options, headers: { cookie: `llmhub_session=${fixture.session}`, ...options.headers }
  })
  const result = await response.json()
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}`)
  return result
}
const contribution = (location, record) => `plugin-contributions/example-dashboard/${location}/${encodeURIComponent(record)}`
try {
  for (const [directory, id] of [['echo', 'example-echo'], ['dashboard-contributions', 'example-dashboard']]) {
    await cp(new URL(`../../examples/plugins/${directory}/`, import.meta.url), join(fixture.directory, '.data/plugins', id), { recursive: true })
  }
  await management('plugins/scan', { method: 'POST' })
  await management('plugins/example-echo/enable', { method: 'POST' })
  await management('plugins/example-dashboard/enable', { method: 'POST' })
  const contributions = await management('plugin-contributions')
  const example = contributions.find(plugin => plugin.id === 'example-dashboard')
  assert.ok(example)
  assert.deepEqual(Object.keys(example.contributes).sort(), ['apiKeys', 'metrics', 'models', 'navigation', 'panels', 'providers'])
  const unauthorized = await fetch(`${fixture.gateway}/api/hub/plugin-contributions`)
  assert.equal(unauthorized.status, 401)
  await management('providers', json('POST', { name: 'dashboard-echo', protocol: 'example-echo:echo' }))
  const { key } = await management('keys', json('POST', { name: 'Dashboard fixture' }))
  const model = 'dashboard-echo/echo'
  // Discover the real model before attaching values; no orphan records are invented.
  await management('models')
  for (const [location, record, values] of [
    ['models', model, { instruction: 'DASHBOARD_MODEL_INSTRUCTION', enabled: true }],
    ['apiKeys', key.id, { team: 'example-team', token: 'private-team-token' }],
    ['providers', 'dashboard-echo', { weight: 3, region: 'remote' }]
  ]) {
    const saved = await management(contribution(location, record), json('PUT', values))
    const expected = { ...values }
    delete expected.token
    assert.deepEqual(saved, expected)
    assert.deepEqual(await management(contribution(location, record)), expected)
  }
  for (const path of [contribution('models', model), 'plugin-contributions/metrics', 'plugins/example-dashboard/panels/status', 'plugins/panel-client']) {
    const denied = await fetch(`${fixture.gateway}/api/hub/${path}`)
    assert.equal(denied.status, 401, path)
  }
  const deniedWrite = await fetch(`${fixture.gateway}/api/hub/${contribution('models', model)}`, json('PUT', { instruction: 'UNAUTHORIZED' }))
  assert.equal(deniedWrite.status, 401)
  const invalidWrite = await fetch(`${fixture.gateway}/api/hub/${contribution('providers', 'dashboard-echo')}`, {
    ...json('PUT', { weight: 'not-a-number' }), headers: { 'content-type': 'application/json', cookie: `llmhub_session=${fixture.session}` }
  })
  assert.equal(invalidWrite.status, 400)
  assert.deepEqual(await management(contribution('providers', 'dashboard-echo')), { weight: 3, region: 'remote' })
  await management(contribution('apiKeys', key.id), json('PUT', { token: '' }))
  assert.equal(JSON.stringify(await management(contribution('apiKeys', key.id))).includes('private-team-token'), false)
  const response = await fetch(`${fixture.gateway}/api/openai/chat/completions`, {
    ...json('POST', { model, messages: [{ role: 'user', content: 'hello' }] }),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key.plain_key}` }
  })
  const completion = await response.json()
  assert.equal(response.status, 200, JSON.stringify(completion))
  assert.ok(completion.choices[0].message.content.includes('DASHBOARD_MODEL_INSTRUCTION'))
  const metrics = await management('plugin-contributions/metrics')
  assert.equal(metrics.find(metric => metric.pluginId === 'example-dashboard' && metric.key === 'requests').value, 1)
  assert.deepEqual(await management('plugins/example-dashboard/api/status'), { requests: 1, changed: true })
  const panel = await fetch(`${fixture.gateway}/api/hub/plugins/example-dashboard/panels/status`, { headers: { cookie: `llmhub_session=${fixture.session}` } })
  assert.equal(panel.status, 200)
  assert.ok(panel.headers.get('content-security-policy').includes("connect-src 'none'"))
  assert.equal(panel.headers.get('content-security-policy').includes('allow-same-origin'), false)
  const panelHTML = await panel.text()
  assert.ok(panelHTML.includes('panel-client'))
  // Headers do not carry into srcdoc: resource restrictions must precede plugin markup.
  assert.ok(panelHTML.indexOf('http-equiv="Content-Security-Policy"') < panelHTML.indexOf('<script>'))
  assert.ok(panelHTML.includes("connect-src 'none'"))
  await management('plugins/example-dashboard/disable', { method: 'POST' })
  assert.equal((await management('plugin-contributions')).some(plugin => plugin.id === 'example-dashboard'), false)
  await management('plugins/example-dashboard/enable', { method: 'POST' })
  assert.equal((await management(contribution('models', model))).instruction, 'DASHBOARD_MODEL_INSTRUCTION')
  await management(`keys/${key.id}`, { method: 'DELETE' })
  await management('providers/dashboard-echo', { method: 'DELETE' })
  assert.equal((await management(contribution('apiKeys', key.id))).team, undefined)
  assert.deepEqual(await management(contribution('providers', 'dashboard-echo')), { weight: 1, region: 'local' })
  // Defaults after deletion alone could hide stale storage; recreate the same provider ID.
  await management('providers', json('POST', { name: 'dashboard-echo', protocol: 'example-echo:echo' }))
  assert.deepEqual(await management(contribution('providers', 'dashboard-echo')), { weight: 1, region: 'local' })
  await management('providers/dashboard-echo', { method: 'DELETE' })
  await management('plugins/example-dashboard', { method: 'DELETE' })
  assert.equal((await management('plugin-contributions')).some(plugin => plugin.id === 'example-dashboard'), false)
  assert.equal((await management('plugin-contributions/metrics')).some(metric => metric.pluginId === 'example-dashboard'), false)
  const absent = await fetch(`${fixture.gateway}/api/hub/${contribution('models', model)}`, { headers: { cookie: `llmhub_session=${fixture.session}` } })
  assert.equal(absent.status, 404)
  // Reinstalling the same ID must not resurrect model values from the previous installation.
  await cp(new URL('../../examples/plugins/dashboard-contributions/', import.meta.url), join(fixture.directory, '.data/plugins/example-dashboard'), { recursive: true })
  await management('plugins/scan', { method: 'POST' })
  await management('plugins/example-dashboard/enable', { method: 'POST' })
  await management('providers', json('POST', { name: 'dashboard-echo', protocol: 'example-echo:echo' }))
  await management('models')
  assert.deepEqual(await management(contribution('models', model)), { instruction: '', enabled: true })
  await management('providers/dashboard-echo', { method: 'DELETE' })
  await management('plugins/example-dashboard', { method: 'DELETE' })
  await management('plugins/example-echo', { method: 'DELETE' })
  console.log('  ok - runtime dashboard contributions, hook values, metrics, sandbox, lifecycle and clean reinstall')
} finally {
  await fixture.close()
}
