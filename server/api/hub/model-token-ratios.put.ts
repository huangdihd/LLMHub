import { setModelTokenRatioSettings } from '../../stores/model-token-ratios.store'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const settings = await setModelTokenRatioSettings(body)
  return { success: true, settings }
})
