import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const routes = {
  openai: 'server/api/openai/models.get.ts',
  claude: 'server/api/claude/v1/models.get.ts',
  gemini: 'server/api/gemini/[version]/models.get.ts'
} as const
const timestamp = '2026-01-02T03:04:05.000Z'
const capabilities = { tools: true, vision: false, streaming: true }
const models = [
  { id: 'alpha/a b', provider: 'alpha', name: 'a b', display_name: 'Alpha display', capabilities },
  { id: 'beta/b', provider: 'beta', name: 'B', capabilities },
  { id: 'gamma/c', provider: 'gamma', name: 'C', display_name: 'Gamma display', capabilities }
]
type Model = typeof models[number]
type RecordRestrictions = {
  allowed_models?: string[]; allowed_providers?: string[]
  fallback_strategy?: { enabled: boolean; name: string; priority: string[] }
}
const source = Object.fromEntries(Object.entries(routes).map(([protocol, path]) => [protocol,
  ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
]))

// Run the actual handlers; only provider discovery and the clock are substituted.
async function invoke(protocol: keyof typeof routes, record?: RecordRestrictions,
  options: { discoveredModels?: Model[]; failureAt?: 'load' | 'models'; failure?: Error } = {}) {
  const calls: string[] = []
  class ProviderManager {
    async loadProviders() {
      calls.push('load')
      if (options.failureAt === 'load') throw options.failure
    }
    async getModels() {
      calls.push('models')
      if (options.failureAt === 'models') throw options.failure
      return structuredClone(options.discoveredModels ?? models)
    }
  }
  class FixedDate extends Date {
    constructor() { super(timestamp) }
    static now() { return Date.parse(timestamp) }
  }
  function execute(path: string, imports: Record<string, unknown>): any {
    const module = { exports: {} }
    const compiled = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    runInNewContext(compiled, {
      module, exports: module.exports,
      require: (name: string) => { assert.ok(Object.hasOwn(imports, name), name); return imports[name] }
    }, { filename: path })
    return module.exports
  }
  let hooks: any
  if (process.env.CHARACTERIZATION_BASELINE !== '1') {
    hooks = execute('server/core/hooks.ts', {})
    const fallback = execute('builtin/fallback/service.ts', {})
    for (const name of ['access-control', 'fallback']) {
      execute(`builtin/${name}/plugin.ts`, name === 'fallback' ? { './service': fallback } : {}).default.setup({
        registerHook: (hook: any) => hooks.requestHooks.register({ ...hook, id: `${name}:${hook.id}` })
      })
    }
  }
  const module = { exports: {} as { default?: (event: unknown) => Promise<unknown> } }
  runInNewContext(source[protocol], {
    module, exports: module.exports, Date: FixedDate,
    defineEventHandler: (handler: unknown) => handler,
    throwFormattedError: (error: unknown) => { throw error },
    require: (name: string) => {
      if (name.endsWith('/core/hooks') && hooks) return hooks
      assert.ok(name.endsWith('/providers/manager'), name)
      return { ProviderManager }
    }
  }, { filename: routes[protocol] })
  const result = await module.exports.default!({ context: { _apiKeyRecord: record } })
  assert.deepEqual(calls, ['load', 'models'])
  // JSON is the public wire contract, including omission of undefined fields.
  return JSON.parse(JSON.stringify(result))
}
function expected(protocol: keyof typeof routes, selected: Model[]) {
  if (protocol === 'openai') return { object: 'list', data: selected.map(model => ({
    id: model.id, object: 'model', created: 1767323045, owned_by: model.provider, capabilities: model.capabilities
  })) }
  if (protocol === 'claude') return {
    data: selected.map(model => ({ type: 'model', id: model.id,
      ...(model.display_name ? { display_name: model.display_name } : {}), created_at: timestamp })),
    has_more: false, first_id: selected[0]?.id ?? null, last_id: selected.at(-1)?.id ?? null
  }
  return { models: selected.map(model => ({ name: `models/${encodeURIComponent(model.id)}`,
    displayName: model.display_name || model.name, description: '',
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent'], capabilities: model.capabilities
  })) }
}
for (const protocol of Object.keys(routes) as Array<keyof typeof routes>) {
  test(`${protocol}: complete models response with no record or empty restrictions`, async () => {
    assert.deepEqual(await invoke(protocol), expected(protocol, models))
    assert.deepEqual(await invoke(protocol, { allowed_models: [], allowed_providers: [] }), expected(protocol, models))
  })
  test(`${protocol}: empty discovery preserves the complete empty protocol envelope`, async () => {
    assert.deepEqual(await invoke(protocol, undefined, { discoveredModels: [] }), expected(protocol, []))
  })
  test(`${protocol}: discovery failures propagate the original error through the formatter`, async () => {
    for (const failureAt of ['load', 'models'] as const) {
      const failure = new Error(`${failureAt} unavailable`)
      await assert.rejects(invoke(protocol, undefined, { failureAt, failure }), error => error === failure)
    }
  })
  test(`${protocol}: restrictions match exact identifiers rather than prefixes or case variants`, async () => {
    for (const record of [{ allowed_models: ['beta', 'BETA/b'] }, { allowed_providers: ['alph', 'Alpha'] }]) {
      assert.deepEqual(await invoke(protocol, record), expected(protocol, []))
    }
  })
  test(`${protocol}: model and provider restrictions are a union and preserve order`, async () => {
    assert.deepEqual(await invoke(protocol, { allowed_models: ['beta/b'], allowed_providers: ['alpha'] }),
      expected(protocol, models.slice(0, 2)))
    assert.deepEqual(await invoke(protocol, { allowed_models: ['beta/b'] }), expected(protocol, [models[1]]))
    assert.deepEqual(await invoke(protocol, { allowed_providers: ['gamma'] }), expected(protocol, [models[2]]))
    assert.deepEqual(await invoke(protocol, { allowed_models: ['missing'] }), expected(protocol, []))
  })
  test(`${protocol}: fallback is inserted after filtering, defaults to auto and avoids visible duplicates`, async () => {
    for (const name of ['', 'custom/route']) {
      const fallbackName = name || 'auto'
      const fallback = { id: fallbackName, name: fallbackName, provider: 'fallback',
        display_name: 'Auto (2 models)', capabilities: { tools: true, vision: true, streaming: true } }
      assert.deepEqual(await invoke(protocol, { allowed_models: ['beta/b'],
        fallback_strategy: { enabled: true, name, priority: ['alpha/a b', 'gamma/c'] } }),
      expected(protocol, [fallback, models[1]]))
    }
    assert.deepEqual(await invoke(protocol, { fallback_strategy: { enabled: true, name: 'beta/b', priority: [] } }),
      expected(protocol, models))
    assert.deepEqual(await invoke(protocol, { allowed_models: ['missing'],
      fallback_strategy: { enabled: true, name: 'beta/b', priority: [] } }), expected(protocol, [
      { id: 'beta/b', name: 'beta/b', provider: 'fallback', display_name: 'Auto (0 models)',
        capabilities: { tools: true, vision: true, streaming: true } }
    ]))
    assert.deepEqual(await invoke(protocol, { allowed_models: ['missing'],
      fallback_strategy: { enabled: false, name: 'auto', priority: [] } }), expected(protocol, []))
  })
}
