export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('error', (error, event) => {
    console.error(`[LLMHub] Error on ${event?.path}:`, error)
  })

  const forceExit = () => {
    console.log('\n[LLMHub] Shutting down...')
    process.exit(0)
  }

  process.on('SIGINT', forceExit)
  process.on('SIGTERM', forceExit)
})