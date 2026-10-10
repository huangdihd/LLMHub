import { reactive } from 'vue'
import type { ApiKeyDashboardExtension } from '../../shared/dashboard/api-keys'
import { accessCatalog, type AccessCatalog } from '../access-control/dashboard-api-key'
import ApiKeyFallbackBadge from './components/ApiKeyFallbackBadge.vue'
import ApiKeyFallbackDetails from './components/ApiKeyFallbackDetails.vue'
import ApiKeyFallbackEditor from './components/ApiKeyFallbackEditor.vue'

export interface FallbackRecord {
  fallback_strategy?: { enabled: boolean; name: string; priority: string[] }
}
export interface FallbackForm {
  fallbackEnabled: boolean
  fallbackName: string
  fallbackPriority: string[]
}

export default {
  id: 'fallback',
  order: 30,
  create(context) {
    const form = reactive<FallbackForm>({ fallbackEnabled: false, fallbackName: 'auto', fallbackPriority: [] })
    const catalog = context.get<AccessCatalog>(accessCatalog)
    return {
      sections: [
        { id: 'fallback-badge', slot: 'badge', order: 20, component: ApiKeyFallbackBadge, props: record => ({ record }) },
        { id: 'fallback-details', slot: 'details', order: 30, component: ApiKeyFallbackDetails, props: record => ({ record }) },
        { id: 'fallback-editor', slot: 'editor', order: 40, component: ApiKeyFallbackEditor, props: () => ({ form, catalog }) }
      ],
      reset(record) {
        const strategy = (record as unknown as FallbackRecord | undefined)?.fallback_strategy
        form.fallbackEnabled = strategy?.enabled || false
        form.fallbackName = strategy?.name || 'auto'
        form.fallbackPriority = [...(strategy?.priority || [])]
      },
      payload: () => ({ fallback_strategy: {
        enabled: form.fallbackEnabled,
        name: form.fallbackName || 'auto',
        priority: form.fallbackPriority.filter(model => model)
      } })
    }
  }
} satisfies ApiKeyDashboardExtension
