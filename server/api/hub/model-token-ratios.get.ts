import { getModelTokenRatioSettings } from '../../stores/model-token-ratios.store'

export default defineEventHandler(async () => getModelTokenRatioSettings())
