import type { PluginAPI } from '../../server/plugins-runtime/manager'
import type { TokenBillingService } from '../token-billing/service'
import { addUsage, cleanupStaleModels } from './service'

export default {
  setup(api: PluginAPI) {
    const billing = api.require<TokenBillingService>('token-billing')
    if (typeof billing?.getBillableTokens !== 'function') {
      throw new Error('quota requires the token-billing service')
    }
    api.registerHook({
      id: 'quota', priority: -100,
      onModelsRefreshed: cleanupStaleModels,
      onAfterIdentity(context) {
        const record = context.apiKeyRecord!
        if (record.monthly_limit > 0 && record.tokens_used >= record.monthly_limit) {
          return { status: 429, message: `Monthly token quota (${record.monthly_limit}) exceeded.`, code: 'quota_exceeded' }
        }
      },
      onModelResolved(context) {
        const record = context.apiKeyRecord!
        const model = context.model
        const modelQuota = record.model_quotas?.[model] || 0
        if (modelQuota > 0 && (record.model_usage?.[model] || 0) >= modelQuota) {
          return { status: 429, message: `Model "${model}" quota (${modelQuota}) exceeded.`, code: 'model_quota_exceeded' }
        }
        const provider = model.includes('/') ? model.split('/')[0] : ''
        if (!provider) return
        const providerQuota = record.provider_quotas?.[provider] || 0
        if (providerQuota > 0 && (record.provider_usage?.[provider] || 0) >= providerQuota) {
          return { status: 429, message: `Provider "${provider}" quota (${providerQuota}) exceeded.`, code: 'provider_quota_exceeded' }
        }
      },
      async onComplete(completion, context) {
        const record = context.apiKeyRecord
        if (!record) return
        if (!completion.usage) return addUsage(record, 0)

        let tokens: number
        try {
          tokens = await billing.getBillableTokens(completion.usage, completion.model)
        } catch (error) {
          // A failed conversion must not erase the completed call or invent token usage.
          await addUsage(record, 0)
          throw error
        }
        const provider = completion.model?.includes('/') ? completion.model.split('/')[0] : undefined
        await addUsage(record, tokens, completion.model, provider)
      }
    })
  }
}
