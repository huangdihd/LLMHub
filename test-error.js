const stream = new ReadableStream({
  async start(controller) {
    try {
      console.log('Fetching...')
      throw new Error('Fake 400 error')
    } catch(e) {
      controller.error(e)
    }
  }
})

async function run() {
  try {
    const reader = stream.getReader()
    const firstRead = await reader.read().catch(err => { throw err })
    console.log(firstRead)
  } catch(e) {
    console.error('Caught stream error:', e)
  }
}
run()
