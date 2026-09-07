import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const buildDir = process.env.ADAPTER_BUILD
if (!buildDir) {
  console.error('ADAPTER_BUILD not set — run via tests/run-all.sh')
  process.exit(1)
}
const { ProviderLoader } = require(`${buildDir}/providers/loader.js`)

let passed = 0
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(() => {
    passed++
    console.log(`  ok - ${name}`)
  }).catch((error: any) => {
    console.error(`  FAIL - ${name}`)
    console.error(error.stack || error.message)
    process.exitCode = 1
  })
}

function model(name: string) {
  return {
    id: `test/${name}`,
    provider: 'test',
    name,
    display_name: name,
    capabilities: {}
  }
}

console.log('model cache')

await test('an expired cache returns stale models while one background refresh runs', async () => {
  ProviderLoader.invalidateCache()

  const loader = new ProviderLoader() as any
  loader.providers.set('test', {})

  let calls = 0
  loader.fetchModels = async () => {
    calls++
    return [model('old')]
  }

  assert.deepEqual(await loader.fetchAllModels(), [model('old')])
  assert.equal(calls, 1)

  ProviderLoader.modelCache.timestamp = 0

  let completeRefresh!: (models: any[]) => void
  loader.fetchModels = () => {
    calls++
    return new Promise(resolve => {
      completeRefresh = resolve
    })
  }

  assert.deepEqual(await loader.fetchAllModels(), [model('old')])
  assert.deepEqual(await loader.fetchAllModels(), [model('old')])
  assert.equal(calls, 2)

  const refreshPromise = ProviderLoader.modelRefreshPromise
  completeRefresh([model('new')])
  await refreshPromise

  assert.deepEqual(await loader.fetchAllModels(), [model('new')])
  assert.equal(calls, 2)
})

await test('an invalidated cache waits for a fresh model list', async () => {
  ProviderLoader.invalidateCache()

  const loader = new ProviderLoader() as any
  loader.providers.set('test', {})
  loader.fetchModels = async () => [model('fresh')]

  assert.deepEqual(await loader.fetchAllModels(), [model('fresh')])
})

console.log(`${passed} model cache tests passed`)
