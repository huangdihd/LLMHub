import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const builtinLayers = readdirSync(new URL('./builtin/', import.meta.url), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(new URL(`./builtin/${entry.name}/nuxt.config.ts`, import.meta.url)))
  .map(entry => fileURLToPath(new URL(`./builtin/${entry.name}`, import.meta.url)))

export default defineNuxtConfig({
  extends: builtinLayers,
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
