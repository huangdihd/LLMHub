import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { PANEL_CSP, servePluginPanel } from '../server/utils/plugin-panel.ts'
import { createEvent } from 'h3'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import ts from 'typescript'
import { PANEL_CHANNEL, PANEL_MAX_BODY_BYTES, acquireExternalLink, releaseExternalLink, panelAPIPath, panelContext, panelExternalURL, validatePanelMessage } from '../shared/dashboard/plugin-panel.ts'

const frame = {}
const request = { channel: PANEL_CHANNEL, type: 'fetch', requestId: '1', path: 'status', method: 'GET' }
const validate = (data: unknown, source: unknown = frame, origin = 'null') => validatePanelMessage({ data, source, origin }, frame, 'example')

test('panel bridge accepts only its exact opaque frame and protocol envelope', () => {
  assert.equal(validate(request)?.type, 'fetch')
  for (const source of [null, {}, undefined]) assert.equal(validatePanelMessage({ data: request, source, origin: 'null' }, frame, 'example'), null)
  assert.equal(validatePanelMessage({ data: request, source: null, origin: 'null' }, null, 'example'), null)
  for (const origin of ['', 'https://host.example', '*']) assert.equal(validate(request, frame, origin), null)
  for (const data of [null, [], 'fetch', 1, true, {}, { ...request, channel: 'other' }, { ...request, type: 'admin' }, { ...request, headers: {} }]) assert.equal(validate(data), null)
})

test('API paths cannot escape the owning plugin namespace or exploit normalization', () => {
  assert.equal(panelAPIPath('example', 'status'), '/api/hub/plugins/example/api/status')
  assert.equal(panelAPIPath('example', '/api/hub/plugins/example/api/status?limit=1'), '/api/hub/plugins/example/api/status?limit=1')
  for (const path of ['', '/', '//evil.test', 'https://evil.test', '/api/hub/plugins/other/api/status', '/api/hub/config', '../config', 'a/../config', './status', 'a//b', 'a\\b', 'a%2fb', '%252e%252e', 'status#x', 'status\n', 'status?x=%2f', 'status??x', null, 42]) {
    assert.equal(validate({ ...request, path }), null, String(path))
  }
  assert.equal(panelAPIPath('../bad', 'status'), null)
})

test('fetch validates request IDs, methods, JSON-only bodies, depth and size', () => {
  for (const requestId of ['', 'a'.repeat(65), {}, 1, 'a b']) assert.equal(validate({ ...request, requestId }), null)
  for (const method of ['get', 'HEAD', 'CONNECT', 'OPTIONS', '', null, 1]) assert.equal(validate({ ...request, method }), null)
  assert.equal(validate({ ...request, body: null }), null)
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  let nested: unknown = null
  for (let index = 0; index < 25; index++) nested = { nested }
  for (const body of [undefined, NaN, Infinity, 1n, new Date(), new Map(), new Uint8Array(1), () => {}, cyclic, nested, 'x'.repeat(PANEL_MAX_BODY_BYTES), '界'.repeat(PANEL_MAX_BODY_BYTES / 2)]) {
    assert.equal(validate({ ...request, method: 'POST', body }), null)
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(validate({ ...request, method, body: { value: [null, true, 1, 'text'] } })?.type, 'fetch')
  }
})

test('height and ready messages reject malformed, out-of-range and unexpected fields', () => {
  assert.deepEqual(validate({ channel: PANEL_CHANNEL, type: 'ready' }), { type: 'ready' })
  assert.equal(validate({ channel: PANEL_CHANNEL, type: 'ready', path: 'status' }), null)
  for (const height of [120, 320, 1200]) assert.deepEqual(validate({ channel: PANEL_CHANNEL, type: 'height', height }), { type: 'height', height })
  for (const height of [119, 1201, -1, NaN, Infinity, 200.5, '320', null, undefined]) assert.equal(validate({ channel: PANEL_CHANNEL, type: 'height', height }), null)
  assert.equal(validate({ channel: PANEL_CHANNEL, type: 'height', height: 320, extra: true }), null)
})

test('panel document policy denies network resources and preserves opaque sandboxing', () => {
  for (const directive of ["sandbox allow-scripts", "default-src 'none'", "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(PANEL_CSP.split('; ').includes(directive))
  assert.ok(!PANEL_CSP.includes("'self'"))
  assert.ok(!PANEL_CSP.includes('allow-same-origin'))
  const component = readFileSync(new URL('../components/RuntimePluginPanel.vue', import.meta.url), 'utf8')
  assert.ok(component.includes('sandbox="allow-scripts"'))
  assert.ok(component.includes('credentialless'))
  assert.ok(component.includes(':srcdoc="documentHTML"'))
  assert.ok(!component.includes(':src="source"'))
  assert.ok(component.includes("credentials: 'same-origin'"))
  assert.ok(component.includes("redirect: 'error'"))
})

test('injected client resolves await llmhub.fetch and accepts theme only from parent', async () => {
  const source = readFileSync(new URL('../server/utils/plugin-panel.ts', import.meta.url), 'utf8')
  const script = source.match(/String.raw`([\s\S]*?)`/)![1]!
  const listeners = new Map<string, (event: any) => void>()
  const sent: any[] = []
  const parent = { postMessage: (message: unknown) => sent.push(message) }
  const document = { documentElement: { dataset: {}, style: {} } }
  const window: any = {}
  vm.runInNewContext(script, { window, parent, document, setTimeout, clearTimeout, addEventListener: (name: string, callback: any) => listeners.set(name, callback), dispatchEvent: () => {}, CustomEvent: class {} })
  const result = window.llmhub.fetch('status')
  const message = sent.at(-1)
  assert.equal(message.path, 'status')
  assert.equal(message.method, 'GET')
  listeners.get('message')!({ source: {}, data: { channel: PANEL_CHANNEL, type: 'theme', theme: 'dark' } })
  assert.equal(window.llmhub.theme, 'light')
  listeners.get('message')!({ source: parent, data: { channel: PANEL_CHANNEL, type: 'theme', theme: 'dark' } })
  assert.equal(window.llmhub.theme, 'dark')
  let settled = false
  void result.then(() => { settled = true })
  for (const event of [
    { source: {}, data: { channel: PANEL_CHANNEL, type: 'response', requestId: message.requestId, ok: true } },
    { source: parent, data: { channel: 'wrong', type: 'response', requestId: message.requestId, ok: true } },
    { source: parent, data: { channel: PANEL_CHANNEL, type: 'response', requestId: message.requestId, ok: 'true' } },
    { source: parent, data: { channel: PANEL_CHANNEL, type: 'response', requestId: 'unknown', ok: true } }
  ]) listeners.get('message')!(event)
  await Promise.resolve()
  assert.equal(settled, false)
  listeners.get('message')!({ source: parent, data: { channel: PANEL_CHANNEL, type: 'response', requestId: message.requestId, ok: true, data: { healthy: true } } })
  assert.deepEqual(await result, { healthy: true })
})

test('served panel repeats resource CSP before plugin markup for authenticated srcdoc delivery', async () => {
  const request = new IncomingMessage(new Socket())
  const response = new ServerResponse(request)
  const event = createEvent(request, response)
  const html = await servePluginPanel(event, new URL('../examples/plugins/dashboard-contributions/ui/index.html', import.meta.url).pathname)
  assert.equal(response.getHeader('Content-Security-Policy'), PANEL_CSP)
  assert.match(html, /^\s*<!doctype html><meta http-equiv="Content-Security-Policy"/i)
  assert.ok(html.indexOf("connect-src 'none'") < html.indexOf('<script>'))
  assert.ok(html.indexOf("const channel = 'llmhub:panel:v1'") < html.indexOf('<title>'))
})

test('actual host handler never fetches for rejected messages and scopes authenticated requests', async () => {
  const component = readFileSync(new URL('../components/RuntimePluginPanel.vue', import.meta.url), 'utf8')
  const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!
    .replace(/^import .*$/gm, '')
  const sent: unknown[] = []
  const frameWindow = { postMessage: (message: unknown) => sent.push(message) }
  const fetched: any[] = []
  const context: any = {
    PANEL_CHANNEL, validatePanelMessage, AbortController, setTimeout, clearTimeout,
    defineProps: () => ({ pluginId: 'example', panel: { id: 'status', title: 'Status' } }),
    ref: (value: unknown) => ({ value }), shallowRef: (value: unknown) => ({ value }), computed: (getter: () => unknown) => ({ get value() { return getter() } }),
    useColorMode: () => ({ value: 'dark' }), watch: () => {}, onMounted: () => {}, onBeforeUnmount: () => {},
    $fetch: async (...arguments_: any[]) => { fetched.push(arguments_); return { healthy: true } }
  }
  vm.runInNewContext(ts.transpileModule(`${script}\nglobalThis.host = { frame, height, receive };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, context)
  context.host.frame.value = { contentWindow: frameWindow }
  for (const event of [
    { source: {}, origin: 'null', data: request },
    { source: frameWindow, origin: 'https://host.test', data: request },
    { source: frameWindow, origin: 'null', data: { ...request, path: '/api/hub/config' } },
    { source: frameWindow, origin: 'null', data: { ...request, credentials: 'include' } }
  ]) await context.host.receive(event)
  assert.equal(fetched.length, 0)
  await context.host.receive({ source: frameWindow, origin: 'null', data: request })
  assert.equal(fetched.length, 1)
  assert.equal(fetched[0][0], '/api/hub/plugins/example/api/status')
  assert.equal(fetched[0][1].credentials, 'same-origin')
  assert.equal(fetched[0][1].redirect, 'error')
  assert.equal(fetched[0][1].retry, 0)
  await context.host.receive({ source: frameWindow, origin: 'null', data: { channel: PANEL_CHANNEL, type: 'height', height: 500 } })
  assert.equal(context.host.height.value, 500)
  await context.host.receive({ source: frameWindow, origin: 'null', data: { channel: PANEL_CHANNEL, type: 'height', height: 5000 } })
  assert.equal(context.host.height.value, 500)
})

test('field editor strips secret reads, blocks unresolved catalogs and saves validated models', async () => {
  const component = readFileSync(new URL('../components/RuntimeContributionFields.vue', import.meta.url), 'utf8')
  const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!.replace(/^import .*$/gm, '')
  const runtime = { plugins: { value: [{ id: 'example', name: 'Example', contributes: { apiKeys: [{ key: 'secret', type: 'secret' }, { key: 'label', type: 'string' }] } }] }, error: { value: null }, pending: { value: true } }
  const writes: any[] = []
  let load: () => Promise<void> = async () => {}
  const context: any = {
    defineProps: () => ({ location: 'apiKeys', recordId: 'key-1' }),
    useRuntimePluginContributions: () => runtime,
    runtimeContributionValuesURL: (id: string, location: string, recordId: string) => `${id}/${location}/${recordId}`,
    ref: (value: unknown) => ({ value }), shallowRef: (value: unknown) => ({ value }), computed: (getter: () => unknown) => ({ get value() { return getter() } }),
    watch: (_sources: unknown, callback: () => Promise<void>) => { load = callback },
    nextTick: async () => {}, defineExpose: () => {},
    $fetch: async (url: string, options?: unknown) => {
      if (options) { writes.push([url, options]); return {} }
      return { secret: 'masked-value', label: 'saved' }
    }
  }
  vm.runInNewContext(ts.transpileModule(`${script}\nglobalThis.editor = { validate, save, setForm, values };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, context)
  await load()
  assert.equal(context.editor.values.value.example.secret, undefined)
  context.editor.setForm('example', { validate: () => true })
  assert.equal(context.editor.validate(), false)
  runtime.pending.value = false
  assert.equal(context.editor.validate(), true)
  await context.editor.save('key-1')
  assert.equal(writes.length, 1)
  assert.equal(writes[0][0], 'example/apiKeys/key-1')
  assert.equal(writes[0][1].body.secret, undefined)
  assert.equal(writes[0][1].body.label, 'saved')
  runtime.plugins.value = []
  await load()
  assert.equal(context.editor.validate(), true)
  await context.editor.save('key-1')
  assert.equal(writes.length, 1, 'no contributions must not write extra record values')
})

test('external links reject unsafe URLs and extra fields while preserving full destinations', () => {
  const url = 'https://example.org/login?client=panel&state=abc#finish'
  const message = { channel: PANEL_CHANNEL, type: 'openExternal', requestId: 'link', url }
  assert.deepEqual(validate(message), { type: 'openExternal', requestId: 'link', url })
  for (const url of ['http://example.org', 'javascript:alert(1)', 'data:text/html,x', '//example.org', 'https://user:password@example.org', 'https://example.org\\evil', 'https://example.org\n', ' https://example.org', 'https://', 'https://example.org/' + 'x'.repeat(8192), null]) {
    assert.equal(panelExternalURL(url), null, String(url))
    assert.equal(validate({ ...message, url }), null)
  }
  for (const extra of [{ target: '_self' }, { features: 'opener' }, { requestId: '' }, { requestId: 'a'.repeat(65) }]) assert.equal(validate({ ...message, ...extra }), null)
  assert.equal(validate(message, {}, 'null'), null)
  assert.equal(validate(message, frame, 'https://example.org'), null)
  assert.equal(validate({ channel: PANEL_CHANNEL, type: 'context', requestId: 'context', provider: {} }), null)
})

test('host allows only one external link confirmation across different panels', () => {
  const first = {}, second = {}
  assert.equal(acquireExternalLink(first), true)
  assert.equal(acquireExternalLink(second), false)
  releaseExternalLink(second)
  assert.equal(acquireExternalLink(second), false)
  releaseExternalLink(first)
  assert.equal(acquireExternalLink(second), true)
  releaseExternalLink(second)
})

test('provider context includes only immutable identifiers for the matching panel', () => {
  const panel = { id: 'status', title: 'Status', location: 'provider' as const, page: 'status.html', providerType: 'example:custom' }
  const provider = { name: 'account', type: 'example:custom', connection: { apiKey: 'private' }, enabled: true }
  const context = panelContext(panel, provider)
  assert.deepEqual(context, { provider: { name: 'account', type: 'example:custom' } })
  assert.ok(Object.isFrozen(context) && Object.isFrozen(context.provider))
  assert.deepEqual(panelContext(panel, { ...provider, type: 'other:custom' }), { provider: null })
  assert.deepEqual(panelContext({ ...panel, location: 'detail' }, provider), { provider: null })
  assert.deepEqual(panelContext(panel), { provider: null })
})

test('host external link flow requires explicit confirmation, limits pending requests and invalidates stale approvals', async () => {
  const component = readFileSync(new URL('../components/RuntimePluginPanel.vue', import.meta.url), 'utf8')
  const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!.replace(/^import .*$/gm, '')
  const sent: any[] = [], opened: any[] = []
  // Like a cross-origin window: only postMessage may be touched; anything else throws a SecurityError.
  const crossOrigin = (fields: Record<string, unknown>) => new Proxy(fields, { get(object, key) {
    if (key in object) return object[key as string]
    throw new Error(`SecurityError: cross-origin property ${String(key)}`)
  } })
  const target = crossOrigin({ postMessage: (message: unknown) => sent.push(message) })
  // Vue's ref is deep: reading a plain object through it inspects (probes __v_isRef on) its values.
  const deepRef = (initial: unknown) => {
    let value = initial
    return {
      get value() {
        // Plain objects only (the component runs in its own realm, so compare constructor names).
        if (!value || typeof value !== 'object' || Object.getPrototypeOf(value)?.constructor?.name !== 'Object') return value
        return new Proxy(value as object, { get(object, key) { const field = (object as any)[key]; if (field && typeof field === 'object') void field.__v_isRef; return field } })
      },
      set value(next) { value = next }
    }
  }
  // Template refs hold elements, which Vue does not wrap.
  class Frame { contentWindow: unknown; constructor(contentWindow: unknown) { this.contentWindow = contentWindow } }
  const properties = { pluginId: 'example', panel: { id: 'status', title: 'Status', location: 'provider', providerType: 'example:custom' }, provider: { name: 'account', type: 'example:custom', secret: 'private' } }
  let timeout: () => void = () => {}
  const context: any = {
    PANEL_CHANNEL, acquireExternalLink, releaseExternalLink, panelContext, panelExternalURL, validatePanelMessage, AbortController,
    setTimeout: (callback: () => void) => { timeout = callback; return 1 }, clearTimeout: () => {},
    window: { open: (...arguments_: unknown[]) => opened.push(arguments_) },
    defineProps: () => properties,
    ref: deepRef, shallowRef: (value: unknown) => ({ value }), computed: (getter: () => unknown) => ({ get value() { return getter() } }),
    useColorMode: () => ({ value: 'dark' }), watch: () => {}, onMounted: () => {}, onBeforeUnmount: () => {},
    $fetch: () => { throw new Error('External URLs must never be fetched by host') }
  }
  vm.runInNewContext(ts.transpileModule(`${script}\nglobalThis.host = { frame, receive, finishExternal, externalRequest, reset, loaded };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, context)
  const host = context.host
  host.frame.value = new Frame(target)
  const send = (type: string, requestId: string, extra = {}) => host.receive({ source: target, origin: 'null', data: { channel: PANEL_CHANNEL, type, requestId, ...extra } })
  await send('context', 'context')
  assert.deepEqual(sent.at(-1).data, { provider: { name: 'account', type: 'example:custom' } })
  const url = 'https://example.org/login?state=complete#fragment'
  await send('openExternal', 'first', { url })
  assert.equal(opened.length, 0)
  assert.equal(host.externalRequest.value.url, url)
  await send('openExternal', 'second', { url: 'https://other.org' })
  assert.equal(sent.at(-1).ok, false)
  assert.equal(host.externalRequest.value.url, url)
  host.finishExternal(true)
  assert.deepEqual(opened, [[url, '_blank', 'noopener,noreferrer']])
  host.finishExternal(true)
  assert.equal(opened.length, 1)
  await send('openExternal', 'cancel', { url })
  host.finishExternal(false)
  assert.equal(sent.at(-1).data, false)
  await send('openExternal', 'timeout', { url })
  timeout()
  host.finishExternal(true)
  assert.equal(opened.length, 1)
  await send('openExternal', 'reset', { url })
  host.reset()
  host.finishExternal(true)
  assert.equal(opened.length, 1)
  await send('openExternal', 'navigation', { url })
  host.loaded()
  host.finishExternal(true)
  assert.equal(opened.length, 1)
  await send('openExternal', 'stale', { url })
  host.frame.value = new Frame({})
  host.finishExternal(true)
  assert.equal(opened.length, 1)
  assert.ok(component.includes('{{ externalRequest.url }}'))
  assert.ok(!component.includes('v-html'))
})

test('injected context helper freezes identifier-only data and external helper awaits host', async () => {
  const source = readFileSync(new URL('../server/utils/plugin-panel.ts', import.meta.url), 'utf8')
  const script = source.match(/String.raw`([\s\S]*?)`/)![1]!
  const listeners = new Map<string, (event: any) => void>(), sent: any[] = []
  const parent = { postMessage: (message: unknown) => sent.push(message) }, window: any = {}
  vm.runInNewContext(script, { window, parent, setTimeout, clearTimeout, addEventListener: (name: string, callback: any) => listeners.set(name, callback) })
  const result = window.llmhub.getContext()
  const answer = (data: unknown) => listeners.get('message')!({ source: parent, data: { channel: PANEL_CHANNEL, type: 'response', requestId: sent.at(-1).requestId, ok: true, data } })
  assert.equal(sent.at(-1).type, 'context')
  answer({ provider: { name: 'account', type: 'example:custom', secret: 'private' }, configuration: 'private' })
  const context = await result
  assert.equal(JSON.stringify(context), '{"provider":{"name":"account","type":"example:custom"}}')
  assert.ok(Object.isFrozen(context) && Object.isFrozen(context.provider))
  const external = window.llmhub.openExternal('https://example.org')
  assert.equal(sent.at(-1).type, 'openExternal')
  answer(false)
  assert.equal(await external, false)
})
