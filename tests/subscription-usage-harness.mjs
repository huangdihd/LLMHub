import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
export function harness(fetch = async () => ({})) {
  const notifications = [], errors = [], mounted = [], unmounted = [], intervals = new Set()
  let accepted = true
  const context = { form: {}, editingProvider: vue.ref(null), isModalOpen: vue.ref(false), validateBasics: () => true, loadProviders: async () => {}, showError: (...arguments_) => errors.push(arguments_) }
  const globals = { $fetch: fetch, useToast: () => ({ add: notification => notifications.push(notification) }), navigateTo: () => {}, confirm: () => accepted,
    setInterval: callback => { intervals.add(callback); return callback }, clearInterval: callback => intervals.delete(callback), setTimeout, clearTimeout }
  const vueModule = { ...vue, onMounted: callback => mounted.push(callback), onBeforeUnmount: callback => unmounted.push(callback) }
  function execute(source, filename, bindings = {}) {
    const module = { exports: {} }
    const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    vm.runInNewContext(javascript, { ...globals, ...bindings, module, exports: module.exports, require: name => name === 'vue' ? vueModule : require(name) }, { filename })
    return module.exports
  }
  function source(path) {
    return readFileSync(resolve(root, path), 'utf8')
  }
  function state() {
    return execute(source('composables/useSubscriptionUsage.ts'), 'usage.ts').useSubscriptionUsage(context.showError)
  }
  function component(path) {
    const { descriptor } = parse(source(path), { filename: path })
    return execute(compileScript(descriptor, { id: 'usage-test', inlineTemplate: true }).content, path).default
  }
  async function render(provider, state, supportsReset = provider === 'codex') {
    const record = { name: 'account', display_name: 'Account', connection: {} }
    const panel = component('components/SubscriptionUsagePanel.vue')
    const controls = provider !== 'claude-subscription' ? component(`builtin/provider-${provider}/components/ProviderDetails.vue`) : null
    const controlState = vue.reactive({ autoResetSaving: {}, aiCreditsSaving: {}, setAutoReset() {}, setAiCredits() {} })
    const application = vue.createSSRApp({ render: () => vue.h(panel, { provider: record, state, supportsReset }, controls ? { controls: () => vue.h(controls, { provider: record, state: controlState }) } : {}) })
    for (const name of ['UBadge', 'UButton', 'UToggle', 'UIcon']) application.component(name, { inheritAttrs: false, setup: (_, { attrs, slots }) => () => vue.h(name.toLowerCase(), attrs, slots.default?.()) })
    return (await renderToString(application)).replace(/<!--[\s\S]*?-->/gu, '').replace(/>\s+</gu, '><').trim()
  }
  return { state, render, component, execute, source, context, mounted, unmounted, intervals, notifications, errors, setAccepted: value => { accepted = value } }
}
