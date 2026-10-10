import { reactive } from 'vue'
import type { DashboardSectionExtension } from '~/shared/dashboard/sections'
import SecurityRateLimit from './components/SecurityRateLimit.vue'

export default {
  id: 'rate-limit',
  page: 'security',
  order: 0,
  create() {
    const config = reactive({ rate_limit_enabled: false, rate_limit_max_rpm: 0 })
    return {
      sections: [{ id: 'rate-limit', slot: 'login-settings', order: 0, component: SecurityRateLimit, props: () => ({ config }) }],
      hydrate(data) {
        const settings = data.bruteForce || {}
        config.rate_limit_enabled = settings.rate_limit_enabled ?? false
        config.rate_limit_max_rpm = settings.rate_limit_max_rpm ?? 0
      },
      payload: () => ({ ...config })
    }
  }
} satisfies DashboardSectionExtension
