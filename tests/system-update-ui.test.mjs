import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { compile, computed, createSSRApp, h, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'

const source = readFileSync(new URL('../pages/updates.vue', import.meta.url), 'utf8')
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/u)[1]
const overview = () => ({
  version: '1.0.0', commit: null, deployment: 'service', canUpdate: true,
  command: 'llmhub update', automatic: false, check: { status: 'available', latestVersion: '1.1.0' }, update: null
})

function harness(fetch, confirm = () => true) {
  const mounted = []
  const unmounted = []
  const timers = new Map()
  const navigations = []
  const copied = []
  let nextTimer = 0
  const module = { exports: {} }
  const javascript = ts.transpileModule(`${script}\nexport { system, connectionError, actionError, busy, awaitingUpdate, confirmationOpen, refreshSystem, checkRelease, saveAutomatic, startUpdate, copyCommand, releaseUrl }`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  vm.runInNewContext(javascript, {
    module, exports: module.exports, ref, computed, URL, AbortController, Error,
    useRuntimeConfig: () => ({ public: { buildInformation: { version: '1.0.0', commit: null, deployment: 'unknown' } } }),
    $fetch: fetch,
    onMounted: callback => mounted.push(callback),
    onBeforeUnmount: callback => unmounted.push(callback),
    navigateTo: destination => navigations.push(destination),
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer },
    clearTimeout: timer => timers.delete(timer),
    navigator: { clipboard: { writeText: async text => copied.push(text) } },
    window: { confirm }
  })
  return {
    page: module.exports, timers, navigations, copied,
    mount: () => mounted[0](),
    unmount: () => unmounted[0](),
    tick: async () => {
      const [id, callback] = timers.entries().next().value
      timers.delete(id)
      await callback()
    }
  }
}

test('polling recovers from downtime, shows persisted outcome and stops on unmount', async () => {
  let requests = 0
  const environment = harness(async () => {
    requests++
    if (requests < 3) throw new Error('Host offline')
    return { ...overview(), update: { phase: 'completed', tag: 'v1.1.0' } }
  })
  await environment.mount()
  assert.match(environment.page.connectionError.value, /Host offline.*Retrying/)
  assert.equal(environment.timers.size, 1)
  await environment.tick()
  assert.equal(environment.timers.size, 1)
  await environment.tick()
  assert.equal(environment.page.connectionError.value, '')
  assert.equal(environment.page.system.value.update.phase, 'completed')
  environment.unmount()
  assert.equal(environment.timers.size, 0)
})

test('unmount aborts in-flight reads without scheduling further polls', async () => {
  let finish
  let signal
  const environment = harness((url, options) => {
    signal = options.signal
    return new Promise(resolve => { finish = resolve })
  })
  const mounting = environment.mount()
  environment.unmount()
  assert.equal(signal.aborted, true)
  finish(overview())
  await mounting
  assert.equal(environment.page.system.value, null)
  assert.equal(environment.timers.size, 0)
})

test('update submits one empty POST, never retries a lost response and reconnects', async () => {
  const calls = []
  let updating = false
  let offline = false
  const environment = harness(async (url, options) => {
    calls.push({ url, options })
    if (options.method === 'POST') {
      updating = true
      offline = true
      throw new Error('Connection lost')
    }
    if (offline) throw new Error('Restarting')
    return { ...overview(), update: updating ? { phase: 'restarting' } : null }
  })
  await environment.mount()
  environment.page.confirmationOpen.value = true
  await environment.page.startUpdate()
  const submitted = calls.find(call => call.options.method === 'POST')
  assert.equal(submitted.url, '/api/hub/system/update')
  assert.equal(JSON.stringify(submitted.options.body), '{}')
  assert.equal(submitted.options.retry, 0)
  assert.equal(environment.page.awaitingUpdate.value, true)
  assert.match(environment.page.actionError.value, /may already have accepted/)
  await environment.page.startUpdate()
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1)
  offline = false
  await environment.tick()
  assert.equal(environment.page.system.value.update.phase, 'restarting')
  assert.equal(environment.page.busy.value, true)
  environment.unmount()
})

test('automatic setting persists via PUT and refresh, not an optimistic toggle', async () => {
  let automatic = false
  const calls = []
  const environment = harness(async (url, options) => {
    calls.push({ url, options })
    if (options.method === 'PUT') automatic = options.body.automatic
    return { ...overview(), automatic }
  })
  await environment.mount()
  await environment.page.saveAutomatic(true)
  assert.equal(environment.page.system.value.automatic, true)
  const write = calls.find(call => call.options.method === 'PUT')
  assert.equal(write.url, '/api/hub/system/settings')
  assert.equal(JSON.stringify(write.options.body), '{"automatic":true}')
  environment.unmount()
})

test('failed settings stay unchanged and checks can be enabled without install confirmation', async () => {
  const environment = harness(async (url, options) => {
    if (options.method === 'PUT') throw new Error('Cannot save')
    return overview()
  })
  await environment.mount()
  await environment.page.saveAutomatic(true)
  assert.equal(environment.page.system.value.automatic, false)
  assert.match(environment.page.actionError.value, /Cannot save/)
  environment.unmount()
  let writes = 0
  const cancelled = harness(async (url, options) => {
    if (options.method) writes++
    return overview()
  }, () => false)
  await cancelled.mount()
  await cancelled.page.saveAutomatic(true)
  assert.equal(writes, 1)
  cancelled.unmount()
})

test('manual checks refresh status; clipboard and release links are safe', async () => {
  const calls = []
  const environment = harness(async (url, options) => {
    calls.push({ url, options })
    return overview()
  })
  await environment.mount()
  await environment.page.checkRelease()
  assert.equal(calls[1].url, '/api/hub/system/check')
  assert.equal(calls[1].options.method, 'POST')
  assert.equal(calls[2].url, '/api/hub/system')
  await environment.page.copyCommand()
  assert.deepEqual(environment.copied, ['llmhub update'])
  environment.page.system.value.check.releaseUrl = 'javascript:alert(1)'
  assert.equal(environment.page.releaseUrl.value, null)
  environment.page.system.value.check.releaseUrl = 'https://github.com/releases/v1.1.0'
  assert.equal(environment.page.releaseUrl.value, 'https://github.com/releases/v1.1.0')
  assert.match(source, /rel="noopener noreferrer"/)
  environment.unmount()
})

test('dashboard notice is conditional and version footer is authenticated-only', () => {
  const notice = readFileSync(new URL('../components/SystemUpdateNotice.vue', import.meta.url), 'utf8')
  const dashboard = readFileSync(new URL('../pages/index.vue', import.meta.url), 'utf8')
  const layout = readFileSync(new URL('../layouts/default.vue', import.meta.url), 'utf8')
  const version = readFileSync(new URL('../components/SystemVersion.vue', import.meta.url), 'utf8')
  assert.match(notice, /v-if="system\?\.check\.status === 'available'"/)
  assert.match(dashboard, /<\/PageHeader>\s*<SystemUpdateNotice \/>/)
  assert.match(layout, /<UContainer v-if="authenticated"[^>]*>\s*<SystemVersion \/>/)
  assert.match(version, /to="\/updates"/)
  assert.match(version, /useRuntimeConfig\(\)\.public\.buildInformation/)
})

test('manual update requires an open confirmation and cancellation never submits', async () => {
  let writes = 0
  const environment = harness(async (url, options) => {
    if (options.method === 'POST') writes++
    return overview()
  })
  await environment.mount()
  await environment.page.startUpdate()
  assert.equal(writes, 0)
  environment.page.confirmationOpen.value = true
  environment.page.confirmationOpen.value = false
  await environment.page.startUpdate()
  assert.equal(writes, 0)
  environment.page.confirmationOpen.value = true
  await environment.page.startUpdate()
  assert.equal(writes, 1)
  assert.equal(environment.page.confirmationOpen.value, false)
  assert.match(source, /Requests arriving during the restart will fail/)
  assert.match(source, /@click="confirmationOpen = false">Cancel/)
  environment.unmount()
})

test('a pre-update poll cannot overwrite recovered status or unlock a duplicate update', async () => {
  let finishStaleRead
  let reads = 0
  let writes = 0
  const environment = harness(async (url, options) => {
    if (options.method === 'POST') { writes++; return overview() }
    reads++
    if (reads === 2) return new Promise(resolve => { finishStaleRead = resolve })
    return { ...overview(), update: reads > 2 ? { phase: 'restarting' } : null }
  })
  await environment.mount()
  const stalePoll = environment.tick()
  environment.page.confirmationOpen.value = true
  await environment.page.startUpdate()
  assert.equal(environment.page.system.value.update.phase, 'restarting')
  finishStaleRead(overview())
  await stalePoll
  assert.equal(environment.page.system.value.update.phase, 'restarting')
  assert.equal(environment.page.busy.value, true)
  environment.page.confirmationOpen.value = true
  await environment.page.startUpdate()
  assert.equal(writes, 1)
  environment.unmount()
})

test('dashboard notice renders no element or spacing unless an update is available', async () => {
  const notice = readFileSync(new URL('../components/SystemUpdateNotice.vue', import.meta.url), 'utf8')
  const template = notice.slice(notice.indexOf('<template>') + 10, notice.indexOf('<script setup')).replace(/<\/template>\s*$/u, '')
  const render = compile(template)
  async function renderNotice(system) {
    const application = createSSRApp({ setup: () => ({ system }), render })
    application.component('UIcon', { render: () => h('i') })
    application.component('NuxtLink', { render() { return h('a', this.$slots.default?.()) } })
    return renderToString(application)
  }
  for (const status of ['unchecked', 'current', 'no-releases', 'error']) {
    assert.match(await renderNotice({ ...overview(), check: { status } }), /^<!--[\s\S]*-->$/u)
  }
  assert.match(await renderNotice(null), /^<!--[\s\S]*-->$/u)
  assert.match(await renderNotice(overview()), /<a[\s\S]*is available/)
})

test('expired authentication redirects to login instead of a dead update page', async () => {
  const environment = harness(async () => { throw { statusCode: 401 } })
  await environment.mount()
  assert.equal(environment.navigations[0].path, '/login')
  assert.equal(environment.navigations[0].query.redirect, '/updates')
  assert.equal(environment.timers.size, 0)
  environment.unmount()
})
