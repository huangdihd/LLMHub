import { reactive } from 'vue'
import type { ApiKeyDashboardExtension } from '../../shared/dashboard/api-keys'
import { accessCatalog, type AccessCatalog } from '../access-control/dashboard-api-key'
import ApiKeyQuotaBadge from './components/ApiKeyQuotaBadge.vue'
import ApiKeyQuotaMeter from './components/ApiKeyQuotaMeter.vue'
import ApiKeyQuotaDetails from './components/ApiKeyQuotaDetails.vue'
import ApiKeyQuotaLimitEditor from './components/ApiKeyQuotaLimitEditor.vue'
import ApiKeyQuotaEditor from './components/ApiKeyQuotaEditor.vue'

export interface QuotaRecord {
  monthly_limit: number
  tokens_used: number
  model_quotas?: Record<string, number>
  provider_quotas?: Record<string, number>
}
export interface QuotaForm {
  monthly_limit: number
  modelQuotaList: { model: string; limit: number }[]
  providerQuotaList: { provider: string; limit: number }[]
}

export default {
  id: 'quota',
  order: 20,
  create(context) {
    const form = reactive<QuotaForm>({ monthly_limit: 0, modelQuotaList: [], providerQuotaList: [] })
    const catalog = context.get<AccessCatalog>(accessCatalog)
    return {
      sections: [
        { id: 'quota-badge', slot: 'badge', order: 10, component: ApiKeyQuotaBadge, props: record => ({ record }) },
        { id: 'quota-meter', slot: 'meter', order: 10, component: ApiKeyQuotaMeter, props: record => ({ record }) },
        { id: 'quota-details', slot: 'details', order: 20, component: ApiKeyQuotaDetails, props: record => ({ record }) },
        { id: 'quota-limit-editor', slot: 'editor', order: 10, component: ApiKeyQuotaLimitEditor, props: () => ({ form }) },
        { id: 'quota-editor', slot: 'editor', order: 30, component: ApiKeyQuotaEditor, props: () => ({ form, catalog }) }
      ],
      reset(record) {
        const quota = record as unknown as QuotaRecord | undefined
        form.monthly_limit = quota?.monthly_limit || 0
        form.modelQuotaList = Object.entries(quota?.model_quotas || {})
          .filter(([, limit]) => limit > 0).map(([model, limit]) => ({ model, limit }))
        form.providerQuotaList = Object.entries(quota?.provider_quotas || {})
          .filter(([, limit]) => limit > 0).map(([provider, limit]) => ({ provider, limit }))
      },
      payload() {
        const modelQuotas: Record<string, number> = {}
        for (const entry of form.modelQuotaList) {
          if (entry.model && entry.limit > 0) modelQuotas[entry.model] = entry.limit
        }
        const providerQuotas: Record<string, number> = {}
        for (const entry of form.providerQuotaList) {
          if (entry.provider && entry.limit > 0) providerQuotas[entry.provider] = entry.limit
        }
        return { monthly_limit: form.monthly_limit, model_quotas: modelQuotas, provider_quotas: providerQuotas }
      }
    }
  }
} satisfies ApiKeyDashboardExtension
