import { setThinkingSettings } from '../../stores/thinking.store'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const settings = await setThinkingSettings(body)
  return { success: true, settings }
})
