import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const buildDirectory = process.env.ADAPTER_BUILD
if (!buildDirectory) throw new Error('Run through tests/run-all.sh')
const { parseProxyPath, proxyTarget, withoutSession, forwardedHeaders, sameOrigin } = require(`${buildDirectory}/utils/plugin-proxy.js`)

test('proxy paths name the plugin, the proxy and the rest of the path', () => {
  assert.deepEqual(parseProxyPath('/api/hub/plugins/plugin-studio/proxy/vscode/static/a%20b.js'), { pluginId: 'plugin-studio', proxyId: 'vscode', rest: '/static/a%20b.js' })
  assert.deepEqual(parseProxyPath('/api/hub/plugins/p1/proxy/x'), { pluginId: 'p1', proxyId: 'x', rest: '/' })
  for (const path of ['/api/hub/plugins/p1/api/x', '/api/hub/plugins/P1/proxy/x/', '/api/hub/plugins/p1/proxy/', '/api/hub/plugins/p1/proxyx/a']) assert.equal(parseProxyPath(path), null, path)
})

test('targets keep the base path, the rest and the query', () => {
  assert.equal(proxyTarget(new URL('http://127.0.0.1:3100/base/'), '/a/b', '?q=1').href, 'http://127.0.0.1:3100/base/a/b?q=1')
  assert.equal(proxyTarget(new URL('http://127.0.0.1:3100'), '/', '').href, 'http://127.0.0.1:3100/')
})

test('the dashboard session never reaches the proxied service', () => {
  assert.equal(withoutSession('a=1; llmhub_session=secret; b=2'), 'a=1; b=2')
  assert.equal(withoutSession('llmhub_session=secret'), '')
  const headers = forwardedHeaders({ cookie: 'llmhub_session=secret; vscode-tkn=t', host: 'hub', connection: 'upgrade', 'sec-websocket-key': 'k', accept: ['a', 'b'] }, 'hub.example', 'https')
  assert.equal(headers.get('cookie'), 'vscode-tkn=t')
  assert.equal(headers.get('host'), null)
  assert.equal(headers.get('connection'), null)
  assert.equal(headers.get('sec-websocket-key'), null)
  assert.equal(headers.get('accept'), 'a, b')
  assert.equal(headers.get('x-forwarded-host'), 'hub.example')
  assert.equal(headers.get('x-forwarded-proto'), 'https')
  assert.equal(forwardedHeaders({ cookie: 'llmhub_session=secret' }, 'h', 'http').has('cookie'), false)
})

test('WebSocket handshakes must come from the dashboard origin', () => {
  assert.equal(sameOrigin(new Headers({ origin: 'https://hub.example', host: 'hub.example' })), true)
  assert.equal(sameOrigin(new Headers({ origin: 'https://evil.example', host: 'hub.example' })), false)
  assert.equal(sameOrigin(new Headers({ host: 'hub.example' })), false)
  assert.equal(sameOrigin(new Headers({ origin: 'null', host: 'hub.example' })), false)
})
