import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'

const require = createRequire(import.meta.url)
const buildDirectory = process.env.ADAPTER_BUILD
if (!buildDirectory) throw new Error('Run through tests/run-all.sh')
const { validateFields, validateConfiguration, validateContributions } = require(`${buildDirectory}/plugins-runtime/manifest.js`)

test('multiline text schema preserves flags and newline values', () => {
  for (const multiline of [undefined, false, true]) {
    const field = { key: 'messages', type: 'text', ...(multiline === undefined ? {} : { multiline }), default: 'one\ntwo' }
    const fields = validateFields([field])
    assert.deepEqual(fields, [field])
    assert.notEqual(fields[0], field)
    assert.deepEqual(validateConfiguration(fields, {}), { messages: 'one\ntwo' })
    assert.deepEqual(validateConfiguration(fields, { messages: 'three\nfour' }), { messages: 'three\nfour' })
    assert.deepEqual(validateContributions({ models: [field] }), { models: [field] })
  }
})

test('multiline rejects non-booleans and every non-text field type', () => {
  for (const multiline of [null, 'true', 1, [], {}]) {
    assert.throws(() => validateFields([{ key: 'messages', type: 'text', multiline }]), /Invalid plugin schema/)
  }
  for (const type of ['secret', 'number', 'boolean', 'select']) {
    for (const multiline of [true, false]) {
      const field = { key: 'value', type, multiline, options: [{ label: 'One', value: 1 }] }
      assert.throws(() => validateFields([field]), /Invalid plugin schema/)
      assert.throws(() => validateContributions({ providers: [field] }), /Invalid plugin schema/)
    }
  }
})

const filename = 'components/PluginSchemaForm.vue'
const { descriptor } = parse(readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8'), { filename })
const source = compileScript(descriptor, { id: 'multiline-test', inlineTemplate: true }).content
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const componentModule = { exports: {} as { default?: vue.Component } }
vm.runInNewContext(javascript, { module: componentModule, exports: componentModule.exports, require, ref: vue.ref }, { filename })

for (const compact of [false, true]) {
  test(`schema form selects textarea only for multiline text (compact=${compact})`, async () => {
    const fields = [
      { key: 'messages', type: 'text', multiline: true, default: 'one\ntwo' },
      { key: 'ordinary', type: 'text' },
      { key: 'single', type: 'text', multiline: false },
      { key: 'secret', type: 'secret' },
      { key: 'number', type: 'number' },
      { key: 'boolean', type: 'boolean' },
      { key: 'select', type: 'select', options: [{ label: 'One', value: 1 }] },
    ]
    const controls: { name: string; attributes: Record<string, any> }[] = []
    const updates: Record<string, unknown>[] = []
    const application = vue.createSSRApp({ render: () => vue.h(componentModule.exports.default!, {
      fields, compact, modelValue: { ordinary: 'untouched' },
      'onUpdate:modelValue': (values: Record<string, unknown>) => updates.push(values),
    }) })
    for (const name of ['UInput', 'UTextarea', 'UToggle', 'USelect', 'UFormGroup']) {
      application.component(name, vue.defineComponent({
        inheritAttrs: false,
        setup: (_, { attrs, slots }) => () => {
          if (name !== 'UFormGroup') controls.push({ name, attributes: attrs })
          return vue.h('div', {}, slots.default?.())
        },
      }))
    }
    await renderToString(application)
    assert.deepEqual(controls.map(control => control.name), ['UTextarea', 'UInput', 'UInput', 'UInput', 'UInput', 'UToggle', 'USelect'])
    assert.equal(controls[0].attributes['model-value'], 'one\ntwo')
    assert.equal(controls[1].attributes['model-value'], 'untouched')
    assert.equal(controls[3].attributes.type, 'password')
    assert.equal(controls[4].attributes.type, 'number')
    controls[0].attributes['onUpdate:modelValue']('three\nfour')
    assert.equal(updates[0].messages, 'three\nfour')
    assert.equal(updates[0].ordinary, 'untouched')
  })
}
