import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Offline npm wire fixture: real tarballs, no external requests or dependencies.
export async function createRegistry() {
  const directory = await mkdtemp(join(tmpdir(), 'llmhub-registry-'))
  const packages = new Map()
  const marker = join(directory, 'INSTALL-SCRIPT-RAN')
  const add = async (name, version, metadata, code) => {
    const staging = join(directory, `${name}-${version}`)
    await mkdir(join(staging, 'package'), { recursive: true })
    const manifest = { name, version, type: 'module', main: 'index.mjs', ...metadata }
    await writeFile(join(staging, 'package/package.json'), JSON.stringify(manifest))
    await writeFile(join(staging, 'package/index.mjs'), code)
    execFileSync('tar', ['-czf', join(staging, 'package.tgz'), '-C', staging, 'package'])
    const versions = packages.get(name) ?? new Map()
    versions.set(version, { manifest, tarball: await readFile(join(staging, 'package.tgz')) })
    packages.set(name, versions)
  }
  await add('llmhub-fixture-library', '1.0.0', {}, 'export default "library-ok"')
  await add('llmhub-fixture-library', '1.1.0', {}, 'export default "library-upgraded"')
  for (const version of ['1.0.0', '1.1.0']) {
    await add('llmhub-plugin-npm-fixture', version, {
      keywords: ['llmhub-plugin'], llmhub: { id: 'npm-fixture', name: 'Npm fixture' }, engines: { llmhub: '^1.0.0' },
      dependencies: { 'llmhub-fixture-library': version },
      scripts: { postinstall: `node -e "require('fs').writeFileSync('${marker}', 'bad')"` }
    }, `import value from 'llmhub-fixture-library'; export default { setup(api) { api.registerRoute('GET', 'value', () => ({ value, version: '${version}' })) } }`)
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const segments = decodeURIComponent(url.pathname).split('/').filter(Boolean)
    response.setHeader('content-type', 'application/json')
    if (segments[0] === '-' && segments[2] === 'search') {
      response.end(JSON.stringify({ total: 1, objects: [{ package: { name: 'llmhub-plugin-npm-fixture', version: '1.1.0', description: '<script>untrusted</script>', date: '2026-01-01', links: { homepage: 'javascript:alert(1)' } }, score: { final: 1 } }] }))
      return
    }
    const versions = packages.get(segments[0])
    if (!versions) { response.statusCode = 404; response.end('{}'); return }
    if (segments[1] === '-') {
      const version = segments[2].replace(/\.tgz$/, '')
      const entry = versions.get(version)
      if (!entry) { response.statusCode = 404; response.end('{}'); return }
      response.setHeader('content-type', 'application/octet-stream')
      response.end(entry.tarball)
      return
    }
    const metadata = Object.fromEntries([...versions].map(([version, entry]) => [version, {
      ...entry.manifest, dist: { tarball: `${registry}/${segments[0]}/-/${version}.tgz` }
    }]))
    response.end(JSON.stringify({ name: segments[0], 'dist-tags': { latest: [...versions.keys()].at(-1) }, versions: metadata, readme: '<script>untrusted README</script>' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const registry = `http://127.0.0.1:${server.address().port}`
  return { registry, directory, marker, async close() { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) } }
}
