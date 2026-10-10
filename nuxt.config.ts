import { existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import packageInformation from './package.json'

let buildCommit = process.env.LLMHUB_BUILD_COMMIT || ''
if (!buildCommit) {
  try {
    buildCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { /* Source archives and Docker contexts may not include Git metadata. */ }
}
if (buildCommit && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(buildCommit)) throw new Error('LLMHUB_BUILD_COMMIT must be a full Git commit hash')
const buildInformation = {
  version: packageInformation.version,
  commit: buildCommit,
  deployment: process.env.LLMHUB_BUILD_DEPLOYMENT === 'docker' ? 'docker' : 'unknown'
}

const builtinLayers = readdirSync(new URL('./builtin/', import.meta.url), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(new URL(`./builtin/${entry.name}/nuxt.config.ts`, import.meta.url)))
  .map(entry => fileURLToPath(new URL(`./builtin/${entry.name}`, import.meta.url)))

export default defineNuxtConfig({
  extends: builtinLayers,
  runtimeConfig: {
    public: { buildInformation }
  },
  compatibilityDate: '2025-05-15',
  devtools: { enabled: true },
  typescript: {
    strict: true
  },
  modules: [
    '@nuxt/ui'
  ],
  app: {
    head: {
      title: 'LLMHub',
      meta: [
        { name: 'description', content: 'A unified gateway for multiple LLM providers' }
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }
      ]
    }
  },
  nitro: {
    storage: {
      data: {
        driver: 'fs',
        base: './.data'
      }
    }
  }
})
