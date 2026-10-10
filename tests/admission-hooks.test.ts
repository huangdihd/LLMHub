import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import type { AdmissionContext, AdmissionStage, RequestHook } from '../server/core/hooks.ts'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('Run via tests/run-all.sh')
const { HookRegistry } = require(`${build}/core/hooks.js`) as typeof import('../server/core/hooks.ts')
const context = { incomingProtocol: 'openai' }
const admissionContext = { ...context, event: { context: {} }, model: 'provider/model' } as AdmissionContext

for (const stage of ['onBeforeIdentity', 'onAfterIdentity', 'onModelResolved'] as AdmissionStage[]) {
  test(`${stage}: stable priorities, shared context and first rejection stop admission`, async () => {
    const hooks = new HookRegistry()
    const calls: string[] = []
    const rejection = { status: 403, message: 'denied', code: 'access_denied' }
    hooks.register({ id: 'late', priority: 10, [stage]: () => { calls.push('late') } })
    hooks.register({ id: 'first', priority: -10, [stage]: async (value: AdmissionContext) => {
      assert.equal(value, admissionContext)
      calls.push('first')
    } })
    hooks.register({ id: 'reject', priority: -10, [stage]: () => { calls.push('reject'); return rejection } })
    assert.equal(await hooks.admission(stage, admissionContext), rejection)
    assert.deepEqual(calls, ['first', 'reject'])
  })

  test(`${stage}: absent handlers preserve admission; exceptions propagate unchanged`, async () => {
    const hooks = new HookRegistry()
    hooks.register({ id: 'unrelated', onModels: () => [] })
    assert.equal(await hooks.admission(stage, admissionContext), undefined)
    const failure = new Error('admission failed')
    hooks.register({ id: 'failure', [stage]: async () => { throw failure } })
    await assert.rejects(hooks.admission(stage, admissionContext), error => error === failure)
  })
}

test('normalize chains replacements and void observers in priority order', async () => {
  const hooks = new HookRegistry()
  const original = { model: 'first/model', messages: [], config: {} }
  const replacement = { ...original, model: 'second/model' }
  hooks.register({ id: 'observer', priority: 10, onNormalize: (value, metadata) => {
    assert.equal(value, replacement)
    assert.equal(metadata, context)
  } })
  hooks.register({ id: 'replace', priority: -10, onNormalize: () => replacement })
  assert.equal(await hooks.normalize(original, context), replacement)
  assert.equal(original.model, 'first/model')
})

test('models chains empty replacements rather than restoring the original list', async () => {
  const hooks = new HookRegistry()
  const replacement: [] = []
  hooks.register({ id: 'filter', onModels: () => replacement })
  hooks.register({ id: 'observer', onModels: (value, metadata) => {
    assert.equal(value, replacement)
    assert.equal(metadata, context)
  } })
  assert.equal(await hooks.models([], context), replacement)
})

test('accounting awaits ordered hooks for both attempt and usage boundaries', async () => {
  const hooks = new HookRegistry()
  const calls: string[] = []
  hooks.register({ id: 'last', priority: 10, onAccountingComplete: completion => { calls.push(`last:${completion.kind}`) } })
  hooks.register({ id: 'first', priority: -10, onAccountingComplete: async (completion, metadata) => {
    await Promise.resolve()
    assert.equal(metadata, context)
    calls.push(`first:${completion.kind}`)
  } })
  await hooks.accountingComplete({ kind: 'attempt' }, context)
  await hooks.accountingComplete({ kind: 'usage', usage: 0, model: 'provider/model' }, context)
  assert.deepEqual(calls, ['first:attempt', 'last:attempt', 'first:usage', 'last:usage'])
})

test('normalize, models and accounting failures reject and stop subsequent hooks', async () => {
  for (const stage of ['onNormalize', 'onModels', 'onAccountingComplete'] as const) {
    const hooks = new HookRegistry()
    const failure = new Error(stage)
    let reached = false
    hooks.register({ id: 'failure', [stage]: async () => { throw failure } } as RequestHook)
    hooks.register({ id: 'later', [stage]: () => { reached = true } } as RequestHook)
    const pending = stage === 'onNormalize'
      ? hooks.normalize({ model: 'provider/model', messages: [], config: {} }, context)
      : stage === 'onModels' ? hooks.models([], context) : hooks.accountingComplete({ kind: 'attempt' }, context)
    await assert.rejects(pending, error => error === failure)
    assert.equal(reached, false)
  }
})
