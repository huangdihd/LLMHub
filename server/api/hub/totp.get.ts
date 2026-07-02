import { getAuthStore } from '../../stores/auth.store'

export default defineEventHandler(async () => {
  const cfg = await getAuthStore().getTOTPConfig()
  return { enabled: cfg.enabled }
})
