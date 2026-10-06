import { getAuthStore } from '../../../../../stores/auth.store'
import { completeGeminiCliLogin, geminiCliLoginActor } from '../../../../../services/gemini-cli-oauth-login'

export default defineEventHandler(async (event) => {
  if (!(await getAuthStore().isSetup())) {
    throw createError({ statusCode: 403, message: 'Finish administrator setup before connecting Google' })
  }
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Login ID is required' })
  const body = await readBody(event)
  return completeGeminiCliLogin(geminiCliLoginActor(event), id, String(body?.code || ''))
})
