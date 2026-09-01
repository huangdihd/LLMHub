import { getAuthStore } from '../../../../../stores/auth.store'
import {
  claudeLoginActor,
  completeClaudeLogin
} from '../../../../../services/claude-oauth-login'

export default defineEventHandler(async (event) => {
  if (!(await getAuthStore().isSetup())) {
    throw createError({ statusCode: 403, message: 'Finish administrator setup before connecting Claude' })
  }
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Login ID is required' })
  const body = await readBody(event)
  return completeClaudeLogin(claudeLoginActor(event), id, String(body?.code || ''))
})
