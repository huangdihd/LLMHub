import type { LLMRequest } from '../core/types'
import { ensureClaudeAccessToken } from '../services/claude-token-manager'
import {
  CLAUDE_CODE_BETA,
  CLAUDE_CODE_SYSTEM_PROMPT
} from '../utils/claude-auth'
import { ClaudeAdapter } from './claude'

/** Anthropic Messages adapter authenticated with a Claude Code subscription. */
export class ClaudeSubscriptionAdapter extends ClaudeAdapter {
  override name = 'claude-subscription'

  override toProviderRequest(request: LLMRequest): any {
    const payload = super.toProviderRequest(request)
    const requiredPrompt = { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }

    if (Array.isArray(payload.system)) {
      const hasRequiredPrompt = payload.system.some((block: any) => block?.text === CLAUDE_CODE_SYSTEM_PROMPT)
      if (!hasRequiredPrompt) payload.system.unshift(requiredPrompt)
    } else if (typeof payload.system === 'string' && payload.system) {
      payload.system = [requiredPrompt, { type: 'text', text: payload.system }]
    } else {
      payload.system = [requiredPrompt]
    }

    return payload
  }

  protected override async requestHeaders(): Promise<Record<string, string>> {
    const active = await ensureClaudeAccessToken(this.config)
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${active.connection.api_key}`,
      'anthropic-version': active.connection.version || '2023-06-01',
      'anthropic-beta': CLAUDE_CODE_BETA,
      'User-Agent': 'claude-cli/1.0.0',
      'x-app': 'cli'
    }
  }
}
