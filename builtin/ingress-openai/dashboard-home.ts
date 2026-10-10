import endpoint from './components/DashboardEndpoint.vue'
import action from './components/DashboardChatAction.vue'
import type { DashboardHomeContribution } from '../../shared/dashboard/home'

export default { order: 0, endpoint, action } satisfies DashboardHomeContribution
