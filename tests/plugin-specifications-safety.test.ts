import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const build = process.env.ADAPTER_BUILD
if (!build) throw new Error('Run through tests/run-all.sh')
const { npmSpecification, githubSpecification, validateRegistry } = require(`${build}/plugins-runtime/specifications.js`)
const { installProject } = require(`${build}/plugins-runtime/npm-project.js`)

const unsafe = [
  '../local', './local', '/tmp/plugin', 'C:\\plugin', 'file:plugin', 'link:plugin',
  'npm:other', 'plugin@npm:other', 'plugin.tgz?download', 'https://host/plugin.tgz',
  'git+https://github.com/owner/repo', 'git://github.com/owner/repo',
  ' plugin', 'plugin ', 'plugin\n', 'plugin\r\n', 'plug in', 'plug\nin', 'plug\tin',
  'plugin;echo', 'plugin&&echo', 'plugin|echo', '$(echo)', '`echo`',
  'plugin>file', 'plugin<file', 'plugin\\name', 'plugin"name', "plugin'name", '--help', '-x',
]

test('npm object names reject paths, aliases, URL tarballs, whitespace, shell syntax and options', () => {
  for (const name of unsafe) assert.throws(() => npmSpecification({ name }), name)
  for (const input of [null, [], 'plugin', {}, { name: 1 }, { name: 'node_modules' }, { name: 'favicon.ico' }]) assert.throws(() => npmSpecification(input))
  assert.equal(npmSpecification({ name: '@scope/plugin', version: '^1.2.3' }).specification, '@scope/plugin@^1.2.3')
})

test('npm versions reject alternative source specifications and command injection', () => {
  for (const version of [...unsafe, 'latest', 'https://host/package.tgz', '1.0.0 || *', '>=1 <2', '', '1.2.3\n', '*\n', {}, null]) {
    assert.throws(() => npmSpecification({ name: 'plugin', version }), String(version))
  }
  for (const version of ['1.2.3', '^1.0.0', '~1.2.0', '*', '>=1.0.0', '1.0.0-1', '1.2.3-beta.1', '^2.0.0-rc.1', '1.2.3+build.7', '1.2.x']) assert.ok(npmSpecification({ name: 'plugin', version }))
})

test('GitHub accepts structured input, HTTPS .git and tree URLs including slash refs', () => {
  assert.equal(githubSpecification({ url: 'https://github.com/owner/plugin.git' }).specification, 'github:owner/plugin')
  assert.equal(githubSpecification({ url: 'https://github.com/owner/plugin/tree/feature/topic' }).ref, 'feature/topic')
  assert.equal(githubSpecification({ url: 'https://github.com/owner/plugin.git/tree/v1.2.3' }).repo, 'plugin')
  assert.equal(githubSpecification({ owner: 'Owner-1', repo: 'plugin_name', ref: 'v1.2.3' }).ref, 'v1.2.3')
  assert.equal(githubSpecification({ owner: 'owner', repo: 'plugin', ref: 'v1.2.3+build.7' }).ref, 'v1.2.3+build.7')
})

test('GitHub rejects paths, aliases, tarballs, arbitrary hosts, git protocols and hostile refs', () => {
  for (const value of unsafe) {
    assert.throws(() => githubSpecification({ owner: value, repo: 'plugin' }), `owner ${value}`)
    assert.throws(() => githubSpecification({ owner: 'owner', repo: value }), `repo ${value}`)
    assert.throws(() => githubSpecification({ owner: 'owner', repo: 'plugin', ref: value }), `ref ${value}`)
  }
  for (const url of [
    'https://example.org/owner/plugin', 'http://github.com/owner/plugin',
    'https://github.com.evil.test/owner/plugin', 'https://github.com@evil.test/owner/plugin',
    'https://user:password@github.com/owner/plugin', 'https://github.com:443/owner/plugin',
    'git@github.com:owner/plugin.git', 'git+https://github.com/owner/plugin.git',
    'ssh://git@github.com/owner/plugin', 'https://github.com/owner/plugin/archive/main.tar.gz',
    'https://github.com/owner/plugin?query=1', 'https://github.com/owner/plugin#main',
    'https://github.com/owner/plugin/tree/--help', 'https://github.com/owner/plugin/tree/a%2Fb',
    'https://github.com/owner/plugin\n', 'https://github.com/owner/plugin/tree/main\n',
  ]) assert.throws(() => githubSpecification({ url }), url)
  for (const ref of ['a..b', 'a//b', 'a/.hidden', 'a/b.lock', 'a.', 'a/', '@{main}', '', '..']) assert.throws(() => githubSpecification({ owner: 'owner', repo: 'plugin', ref }), ref)
  for (const input of [null, [], 'owner/plugin', { owner: 'owner', repo: 'plugin.git' }, { url: 'https://github.com/owner/plugin', ref: 'main' }]) assert.throws(() => githubSpecification(input))
})

test('registry rejects credentials, query, fragment, non-HTTP schemes and oversized input', () => {
  for (const input of ['file:///tmp', 'git://host', 'https://user:secret@host', 'https://host/?secret=1', 'https://host/#fragment', 'https://host/\n', ' https://host/', 'https:\\host', 'x'.repeat(2049), null]) assert.throws(() => validateRegistry(input))
  assert.equal(validateRegistry('http://localhost:4873'), 'http://localhost:4873/')
})

test('installProject rejects unsafe persisted dependencies before writing files or running npm', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'llmhub-specification-safety-'))
  let calls = 0
  const runner = async () => { calls++ }
  try {
    await writeFile(join(directory, 'package.json'), 'preserved')
    for (const dependencies of [
      { '--help': '*' }, { plugin: 'file:../outside' }, { plugin: 'npm:other' },
      { plugin: 'github:owner/plugin#--help' }, { plugin: 'github:owner/plugin#main;echo' },
      { plugin: 'github:owner/plugin.git' }, { plugin: 'git+https://github.com/owner/plugin' },
    ]) {
      await assert.rejects(installProject(directory, dependencies, 'https://registry.example.test', runner))
      assert.equal(await readFile(join(directory, 'package.json'), 'utf8'), 'preserved')
    }
    await assert.rejects(installProject(directory, { plugin: '*' }, 'https://secret@registry.example.test', runner))
    assert.equal(calls, 0)
    await installProject(directory, { plugin: 'github:owner/plugin#v2.0.0+build.7' }, 'https://registry.example.test', runner)
    assert.equal(calls, 1)
    assert.equal(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).dependencies.plugin, 'github:owner/plugin#v2.0.0+build.7')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
