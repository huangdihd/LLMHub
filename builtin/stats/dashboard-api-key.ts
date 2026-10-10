import type { ApiKeyDashboardExtension } from '../../shared/dashboard/api-keys'
import ApiKeyStatsSummary from './components/ApiKeyStatsSummary.vue'

export interface StatsRecord {
  call_count: number
  tokens_used: number
  created_at: string
}

export default {
  id: 'stats',
  order: 40,
  create: () => ({
    sections: [
      { id: 'stats-summary', slot: 'summary', order: 10, component: ApiKeyStatsSummary, props: record => ({ record }) }
    ]
  })
} satisfies ApiKeyDashboardExtension
