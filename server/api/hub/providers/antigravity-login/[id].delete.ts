import { getAuthStore } from '../../../../stores/auth.store'
import {
  antigravityLoginActor,
  cancelAntigravityLogin
} from '../../../../services/antigravity-oauth-login'

export default defineEventHandler(async (event) => {
  if (!(await getAuthStore().isSetup())) {
    throw createError({ statusCode: 403, message: 'Finish administrator setup before connecting Google' })
  }
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Login ID is required' })
  return cancelAntigravityLogin(antigravityLoginActor(event), id)
})
