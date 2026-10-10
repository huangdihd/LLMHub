import type { DashboardProviderSection } from '~/shared/dashboard/providers'
import Advanced from './components/ProviderAdvanced.vue'

export default {
  id: 'cch-normalization',
  order: 0,
  advanced: Advanced,
  defaults: { normalize_cch: false },
  edit: (form, provider) => { form.normalize_cch = provider.normalize_cch || false },
  payload: form => ({ normalize_cch: form.normalize_cch })
} satisfies DashboardProviderSection
