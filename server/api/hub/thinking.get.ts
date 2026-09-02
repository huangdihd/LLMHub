import { getThinkingSettings } from '../../stores/thinking.store'

export default defineEventHandler(async () => getThinkingSettings())
