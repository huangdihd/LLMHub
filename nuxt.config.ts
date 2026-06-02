export default defineNuxtConfig({
  compatibilityDate: '2025-05-15',
  devtools: { enabled: true },
  typescript: {
    strict: true
  },
  modules: [
    '@nuxt/ui'
  ],
  nitro: {
    storage: {
      data: {
        driver: 'fs',
        base: './.data'
      }
    }
  }
})
