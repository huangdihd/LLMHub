import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import { renderToString } from '@vue/server-renderer'

const root = process.cwd()
const require = createRequire(import.meta.url)
const baseline = process.env.DASHBOARD_BASELINE || '60197062a94bb282149e5d6ecb2f8ec2fecbff9d'
const noop = () => {}
let state = {}
const globals = {
  ...Object.fromEntries(Object.entries(Vue).filter(([name]) => /^[a-zA-Z_$][\w$]*$/.test(name))),
  useToast: () => ({ add: noop }),
  useRoute: () => ({ fullPath: '/' }),
  useColorMode: () => ({ value: 'light', preference: 'light' }),
  navigateTo: noop,
  definePageMeta: noop,
  $fetch: async () => ({}),
  __fixture(name, value) {
    if (Object.hasOwn(state, name)) {
      if (Vue.isRef(value)) value.value = state[name]
      else if (Vue.isReactive(value)) Object.assign(value, state[name])
    }
    return value
  },
  __applyState(target) {
    for (const [key, value] of Object.entries(state)) {
      if (!(key in target)) continue
      if (Vue.isRef(target[key])) {
        if (!Vue.isReadonly(target[key])) target[key].value = value
      } else if (Vue.isReactive(target[key]) && value && typeof value === 'object') Object.assign(target[key], value)
      else target[key] = value
    }
  }
}

function source(path, old) {
  return old ? execFileSync('git', ['show', `${baseline}:${relative(root, path)}`], { encoding: 'utf8' }) : readFileSync(path, 'utf8')
}

function loader(old = false) {
  const cache = new Map()
  function load(path) {
    path = resolve(path)
    if (!existsSync(path) && !old) {
      for (const extension of ['.ts', '.vue', '.js']) if (existsSync(path + extension)) return load(path + extension)
    }
    if (!/\.(vue|ts|js)$/.test(path)) path += '.ts'
    if (cache.has(path)) return cache.get(path)
    let text = source(path, old)
    let template
    if (path.endsWith('.vue')) {
      const { descriptor } = parse(text, { filename: path })
      const script = descriptor.script || descriptor.scriptSetup ? compileScript(descriptor, { id: path }) : { content: 'export default {}', bindings: {} }
      text = script.content.replace('return __returned__', '__applyState(__returned__); return __returned__')
      template = compileTemplate({ source: descriptor.template.content, filename: path, id: path, compilerOptions: { bindingMetadata: script.bindings } })
      assert.equal(template.errors.length, 0, `${path}: ${template.errors}`)
      text += '\n' + template.code
    }
    text = text.replace(/import\.meta\.glob(?:<[^\n]*?>)?\((['"])(.*?)\1,\s*\{\s*eager:\s*true\s*\}\)/g, (_, quote, pattern) => {
      const [prefix, suffix] = pattern.split('*')
      const directory = resolve(dirname(path), prefix)
      const files = readdirSync(directory).map(name => resolve(directory, name + suffix)).filter(existsSync)
      return '{' + files.map(file => JSON.stringify(file) + ': require(' + JSON.stringify(file) + ')').join(',') + '}'
    })
    text = text.replace(/const (\w+) = (ref|reactive)(?:<[^\n]*?>)?\(/g, (match, name, factory) => `const ${name} = ((value) => __fixture('${name}', value))(${factory}(`)
    // Close the fixture wrapper at the matching call parenthesis, including multi-line objects.
    for (let offset = text.indexOf("= ((value) => __fixture("); offset >= 0; offset = text.indexOf("= ((value) => __fixture(", offset + 1)) {
      const start = text.indexOf('))(', offset) + 3
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text.slice(start))
      let depth = 0
      while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
        if (scanner.getToken() === ts.SyntaxKind.OpenParenToken) depth++
        if (scanner.getToken() === ts.SyntaxKind.CloseParenToken && --depth === 0) {
          const end = start + scanner.getTextPos()
          text = text.slice(0, end) + ')' + text.slice(end)
          break
        }
      }
    }
    const compiled = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
    const module = { exports: {} }
    cache.set(path, module.exports)
    const localRequire = name => name === '#imports' ? globals : name.startsWith('.') || name.startsWith('/') || name.startsWith('~/')
      ? load(name.startsWith('~/') ? resolve(root, name.slice(2)) : resolve(dirname(path), name))
      : require(name)
    const scope = { ...globals }
    for (const file of readdirSync(resolve(root, 'composables')).filter(file => file.endsWith('.ts'))) {
      const name = file.slice(0, -3)
      scope[name] = (...args) => load(resolve(root, 'composables', file))[name](...args)
    }
    new Function('require', 'module', 'exports', ...Object.keys(scope), compiled)(localRequire, module, module.exports, ...Object.values(scope))
    if (template) module.exports.default.render = module.exports.render
    cache.set(path, module.exports)
    return module.exports
  }
  return load
}

// The same transparent UI doubles render every slot and preserve incoming attributes
// on both sides. Only Vue's non-visual fragment/conditional comment anchors are removed.
const stub = name => Vue.defineComponent({
  inheritAttrs: false,
  setup(_, { attrs, slots }) {
    return () => Vue.h(name.toLowerCase(), attrs, Object.keys(slots).sort().flatMap(key => slots[key]({ option: { name: 'Example', label: 'Example', value: 'example', id: 'example' } })))
  }
})
function normalize(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').replace(/> </g, '><').trim()
}
async function render(path, old, values) {
  state = structuredClone(values)
  const load = loader(old)
  const component = load(resolve(root, path)).default
  const app = Vue.createSSRApp(component)
  app.component('PluginSchemaForm', load(resolve(root, 'components/PluginSchemaForm.vue')).default)
  for (const name of ['UNotifications', 'UDivider', 'UContainer', 'UCard', 'UButton', 'UIcon', 'UBadge', 'UModal', 'UFormGroup', 'UInput', 'UTextarea', 'USelect', 'USelectMenu', 'UToggle', 'UTabs', 'UDropdown', 'UTooltip', 'UCheckbox', 'URadioGroup', 'UAlert', 'NuxtLink', 'ClientOnly']) app.component(name, stub(name))
  app.config.warnHandler = message => { if (!message.includes('onMounted') && !message.includes('onBeforeUnmount') && !message.includes('Unhandled error')) throw new Error(message) }
  return normalize(await renderToString(app))
}
async function compare(label, before, after, values) {
  const original = await render(before, true, values)
  const current = await render(after, false, values)
  assert.equal(current, original, label)
  console.log(`PASS dashboard HTML: ${label}`)
}

await compare('navigation desktop', 'layouts/default.vue', 'layouts/default.vue', {})
await compare('navigation mobile authenticated', 'layouts/default.vue', 'layouts/default.vue', { mobileMenuOpen: true, authenticated: true })
await compare('thinking', 'pages/thinking.vue', 'builtin/thinking-policy/pages/thinking.vue', {})
await compare('home loading', 'pages/index.vue', 'pages/index.vue', {})
await compare('home populated', 'pages/index.vue', 'pages/index.vue', { loading: false, totalApiCalls: 42, totalProvidersCount: 2, activeProvidersCount: 1, totalModelsCount: 3, protocolCounts: { openai: 1 }, modelsByProvider: { example: 3 }, providerDisplayNames: { example: 'Example' }, apiKeys: [{ id: 'key', name: 'Key', monthly_limit: 100, tokens_used: 120, call_count: 4, allowed_providers: ['example'], allowed_models: ['example/model'] }] })
await compare('security', 'pages/security.vue', 'pages/security.vue', {})
await compare('models', 'pages/models.vue', 'pages/models.vue', {})
await compare('api keys', 'pages/api-keys.vue', 'pages/api-keys.vue', {})
await compare('providers', 'pages/providers.vue', 'pages/providers.vue', {})

const record = { id: 'key', name: 'Example', created_at: '2026-01-01', monthly_limit: 1000, tokens_used: 250, call_count: 12, allowed_providers: ['example'], allowed_models: ['example/model'], model_quotas: { 'example/model': 100 }, provider_quotas: { example: 500 }, fallback_strategy: { enabled: true, name: 'auto', priority: ['example/model'] } }
await compare('api key populated editor and list', 'pages/api-keys.vue', 'pages/api-keys.vue', { loading: false, isModalOpen: true, editingKey: record, keys: [record], availableProviders: [{ name: 'example', display_name: 'Example' }], availableModels: [{ id: 'example/model', name: 'Model', provider: 'example' }], form: { name: 'Example', monthly_limit: 1000, selectedProviders: ['example'], selectedModels: ['example/model'], modelQuotaList: [{ model: 'example/model', limit: 100 }], providerQuotaList: [{ provider: 'example', limit: 500 }], fallbackEnabled: true, fallbackName: 'auto', fallbackPriority: ['example/model'] } })
await compare('security enabled limits and SSRF', 'pages/security.vue', 'pages/security.vue', { loading: false, config: { enabled: true, max_attempts: 7, lockout_duration: 20, rate_limit_enabled: true, rate_limit_max_rpm: 42 }, ssrfConfig: { enabled: true, allowed_hosts: ['example.test'] }, ssrfAllowedHostsText: 'example.test' })
await compare('models billing populated', 'pages/models.vue', 'pages/models.vue', { loading: false, models: [{ id: 'example/model', name: 'Model', provider: 'example', tokenRatios: { input: '125', output: '75', cached: '25' } }], providerDisplayNames: { example: 'Example' } })

const protocols = ['openai', 'claude', 'gemini', 'codex-subscription', 'claude-subscription', 'antigravity-subscription']
for (const protocol of protocols) {
  const form = { name: 'example', display_name: 'Example', protocol, enabled: true, use_custom_models: true, custom_models: [{ id: 'model', display_name: 'Model' }], api_type: 'responses', base_url: 'https://example.test', api_key: 'test-key', timeout: 30000, enable_timeout: true, max_retries: 3, version: '2023-06-01', normalize_cch: true, client_version: '0.149.0', extra: {} }
  const provider = { name: 'example', display_name: 'Example', protocol, enabled: true, authenticated: true, connection: { auto_reset_on_quota_exhausted: true, use_ai_credits: true }, models: [], use_custom_models: false }
  const values = { form, loading: false, isModalOpen: true, protocolChosen: true }
  await compare(`${protocol} create`, 'pages/providers.vue', 'pages/providers.vue', values)
  await compare(`${protocol} edit and list`, 'pages/providers.vue', 'pages/providers.vue', { ...values, editingProvider: provider, providers: [provider] })
  if (!protocol.endsWith('subscription')) continue
  await compare(`${protocol} usage loading`, 'pages/providers.vue', 'pages/providers.vue', { ...values, providers: [provider], subscriptionUsage: { example: { loading: true, resettingCreditId: '', error: '', expanded: false, data: null } } })
  await compare(`${protocol} usage error`, 'pages/providers.vue', 'pages/providers.vue', { ...values, providers: [provider], subscriptionUsage: { example: { loading: false, resettingCreditId: '', error: 'Usage unavailable', expanded: false, data: null } } })
  for (const status of ['pending', 'failed', 'completed', 'cancelled']) {
    await compare(`${protocol} login ${status}`, 'pages/providers.vue', 'pages/providers.vue', { ...values, activeLogin: { login_id: 'login', status, verification_url: 'https://example.test/verify', authorization_url: 'https://example.test/auth', user_code: 'ABCD', expires_at: 0, error: 'Example error' } })
  }
  for (const expanded of [false, true]) {
    await compare(`${protocol} usage expanded=${expanded}`, 'pages/providers.vue', 'pages/providers.vue', { ...values, providers: [provider], subscriptionUsage: { example: { loading: false, resettingCreditId: '', error: '', expanded, data: { provider: 'example', protocol, plan: 'pro', windows: [{ id: 'daily', label: 'Daily', used_percent: 35, detail: 'Example window' }], credits: { balance: 42 }, reset_credits: { available_count: 1, credits: [{ id: 'credit', reset_type: 'daily', status: 'available', title: 'Reset', description: 'Reset credit' }] }, fetched_at: '2026-01-01' } } } })
  }
}
