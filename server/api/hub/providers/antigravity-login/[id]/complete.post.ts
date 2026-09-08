import { getAuthStore } from '../../../../../stores/auth.store'
import {
  antigravityLoginActor,
  completeAntigravityLogin
} from '../../../../../services/antigravity-oauth-login'

export default defineEventHandler(async (event) => {
  if (!(await getAuthStore().isSetup())) {
    throw createError({ statusCode: 403, message: 'Finish administrator setup before connecting Google' })
  }
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Login ID is required' })
  const body = await readBody(event)
  return completeAntigravityLogin(antigravityLoginActor(event), id, String(body?.code || ''))
})
