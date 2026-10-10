import { builtinCatalog } from './builtin/catalog'

export default defineNuxtConfig({
  extends: builtinCatalog.map(plugin => plugin.layer),
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
