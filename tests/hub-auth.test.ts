import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

// Runs the real middleware with only H3 and the auth store replaced.
const source = ts.transpileModule(
  readFileSync(new URL('../server/middleware/hub-auth.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText

async function request(path: string, state: { setup: boolean; session?: string; cookie?: string }) {
  const module = { exports: {} as { default?: (event: unknown) => Promise<unknown> } }
  runInNewContext(source, {
    module, exports: module.exports,
    defineEventHandler: (handler: unknown) => handler,
    require: (name: string) => name === 'h3'
      ? {
          getCookie: () => state.cookie,
          createError: (input: { statusCode: number; data: unknown }) => Object.assign(new Error('rejected'), input)
        }
      : { getAuthStore: () => ({
          isSetup: async () => state.setup,
          validateSession: async (token: string) => token === state.session
        }) }
  })
  try {
    await module.exports.default!({ path })
    return 200
  } catch (error) {
    return (error as { statusCode: number }).statusCode
  }
}

test('management routes are closed until an administrator password exists', async () => {
  assert.equal(await request('/api/hub/providers', { setup: false }), 401)
  assert.equal(await request('/api/hub/plugins/install', { setup: false, cookie: 'anything' }), 401)
})

test('management routes need a valid session once a password exists', async () => {
  assert.equal(await request('/api/hub/providers', { setup: true }), 401)
  assert.equal(await request('/api/hub/providers', { setup: true, session: 'valid', cookie: 'stale' }), 401)
  assert.equal(await request('/api/hub/providers', { setup: true, session: 'valid', cookie: 'valid' }), 200)
})

test('other routes are left to their own checks', async () => {
  assert.equal(await request('/api/auth/setup', { setup: false }), 200)
  assert.equal(await request('/api/openai/v1/models', { setup: false }), 200)
})
