import { getAuthStore } from '../../../../stores/auth.store'
import {
  codexLoginActor,
  startCodexDeviceLogin
} from '../../../../services/codex-device-login'

export default defineEventHandler(async (event) => {
  if (!(await getAuthStore().isSetup())) {
    throw createError({ statusCode: 403, message: 'Finish administrator setup before connecting ChatGPT' })
  }
  const body = await readBody(event)
  const name = String(body?.name || '').trim()
  if (!name) throw createError({ statusCode: 400, message: 'Provider name is required' })
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw createError({ statusCode: 400, message: 'Provider name may only contain lowercase letters, numbers, _ and -' })
  }

  return startCodexDeviceLogin(codexLoginActor(event), {
    name,
    display_name: String(body.display_name || 'Codex Subscription').trim(),
    enabled: body.enabled !== false,
    normalize_cch: body.normalize_cch === true,
    timeout: Number(body.timeout) || 30000,
    enable_timeout: body.enable_timeout !== false,
    max_retries: Number(body.max_retries) || 3,
    use_custom_models: body.use_custom_models === true,
    models: Array.isArray(body.models) ? body.models : [],
    reconnect: body.reconnect === true
  })
})
