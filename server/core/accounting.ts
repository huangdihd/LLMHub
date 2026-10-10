import type { H3Event } from 'h3'
import { requestHooks, type AccountingCompletion, type HookContext, type HookRegistry } from './hooks'

export async function completeAccounting(
  completion: AccountingCompletion,
  context: HookContext,
  hooks: HookRegistry = requestHooks
): Promise<void> {
  if (completion.kind === 'attempt') return hooks.accountingComplete(completion, context)
  if (!context.apiKeyRecord) return
  try {
    await hooks.accountingComplete(completion, context)
  } catch (error) {
    console.error('[LLMHub] Failed to track usage:', error)
  }
}

export function completeIngressAccounting(event: H3Event, incomingProtocol: string, completion: AccountingCompletion): Promise<void> {
  return completeAccounting(completion, { incomingProtocol, apiKeyRecord: event.context?._apiKeyRecord })
}
