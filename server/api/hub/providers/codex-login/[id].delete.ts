import { getAuthStore } from '../../../../stores/auth.store'
import {
  cancelCodexDeviceLogin,
  codexLoginActor
} from '../../../../services/codex-device-login'

export default defineEventHandler(async (event) => {
  if (!(await getAuthStore().isSetup())) {
    throw createError({ statusCode: 403, message: 'Finish administrator setup before connecting ChatGPT' })
  }
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Login ID is required' })
  return cancelCodexDeviceLogin(codexLoginActor(event), id)
})
