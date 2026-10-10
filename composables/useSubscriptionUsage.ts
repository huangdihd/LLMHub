import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'

type SubscriptionUsageWindow = {
  id: string
  label: string
  used_percent: number
  reset_at?: string
  detail?: string
}
type SubscriptionCredits = {
  balance?: number | string
  unlimited?: boolean
  detail?: string
}
type SubscriptionResetCredit = {
  id: string
  reset_type: string
  status: string
  granted_at?: string
  expires_at?: string
  title?: string
  description?: string
}
type SubscriptionUsage = {
  provider: string
  protocol: string
  plan?: string
  windows: SubscriptionUsageWindow[]
  credits?: SubscriptionCredits
  reset_credits?: {
    available_count: number
    credits?: SubscriptionResetCredit[]
  }
  fetched_at: string
}
type SubscriptionUsageState = {
  loading: boolean
  resettingCreditId: string
  error: string
  data: SubscriptionUsage | null
  expanded: boolean
}


export function useSubscriptionUsage(showError: (error: unknown, fallback: string) => void) {
  const toast = useToast()
  const usageNow = ref(Date.now())
  const subscriptionUsage = reactive<Record<string, SubscriptionUsageState>>({})
  let usageClockTimer: ReturnType<typeof setInterval> | null = null
  onMounted(() => { usageClockTimer = setInterval(() => { usageNow.value = Date.now() }, 60000) })
  onBeforeUnmount(() => { if (usageClockTimer) clearInterval(usageClockTimer) })
  function usageState(name: string): SubscriptionUsageState {
    if (!subscriptionUsage[name]) {
      subscriptionUsage[name] = { loading: false, resettingCreditId: '', error: '', data: null, expanded: false }
    }
    return subscriptionUsage[name]
  }

  async function toggleUsageDetails(name: string) {
    const state = usageState(name)
    state.expanded = !state.expanded
    if (state.expanded && !state.data && !state.loading) await fetchSubscriptionUsage(name)
  }

  async function fetchSubscriptionUsage(name: string, refresh = false) {
    const state = usageState(name)
    state.loading = true
    state.error = ''
    try {
      const suffix = refresh ? '?refresh=1' : ''
      const data = await $fetch<SubscriptionUsage>(`/api/hub/providers/${encodeURIComponent(name)}/subscription-usage${suffix}`)
      state.data = {
        provider: data.provider,
        protocol: data.protocol,
        plan: data.plan,
        windows: Array.isArray(data.windows) ? data.windows : [],
        credits: data.credits,
        reset_credits: data.reset_credits,
        fetched_at: data.fetched_at
      }
    } catch (error: any) {
      state.error = error?.data?.message
        || error?.statusMessage
        || 'Unable to load quota details. Try refreshing.'
    } finally {
      state.loading = false
    }
  }

  async function useSubscriptionReset(name: string, credit?: SubscriptionResetCredit) {
    const title = credit?.title || 'usage limit reset'
    if (!confirm(`Use this ${title}? Your eligible usage limits will be reset.`)) return

    const state = usageState(name)
    const pendingId = credit?.id || '__next__'
    state.resettingCreditId = pendingId
    try {
      const result = await $fetch<{ code: string; windows_reset: number }>(
        `/api/hub/providers/${encodeURIComponent(name)}/subscription-reset`,
        { method: 'POST', body: credit ? { credit_id: credit.id } : {} }
      )
      const messages: Record<string, string> = {
        reset: `Reset applied to ${result.windows_reset || 'eligible'} usage limit window${result.windows_reset === 1 ? '' : 's'}.`,
        nothing_to_reset: 'No current usage limit window is eligible for a reset.',
        no_credit: 'That usage limit reset is no longer available.',
        already_redeemed: 'This reset was already used.'
      }
      toast.add({
        title: result.code === 'reset' ? 'Usage limits reset' : 'Reset not applied',
        description: messages[result.code] || `The provider returned: ${result.code}`,
        color: result.code === 'reset' ? 'green' : 'orange',
        icon: result.code === 'reset' ? 'i-heroicons-check-circle' : 'i-heroicons-information-circle'
      })
      await fetchSubscriptionUsage(name, true)
    } catch (error: any) {
      showError(error, 'Unable to use usage limit reset')
    } finally {
      state.resettingCreditId = ''
    }
  }

  function titleCase(value: string): string {
    return value
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, character => character.toUpperCase())
  }

  function clampPercent(value: number): number {
    const percent = Number(value)
    if (!Number.isFinite(percent)) return 0
    return Math.min(100, Math.max(0, percent))
  }

  function formatPercent(value: number): string {
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(clampPercent(value))}%`
  }

  function formatResetTime(resetAt: string): string {
    const timestamp = Date.parse(resetAt)
    if (!Number.isFinite(timestamp)) return 'at an unknown time'

    const absolute = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(timestamp)
    const seconds = (timestamp - usageNow.value) / 1000
    let value: number
    let unit: Intl.RelativeTimeFormatUnit
    if (Math.abs(seconds) < 60) {
      value = Math.round(seconds)
      unit = 'second'
    } else if (Math.abs(seconds) < 3600) {
      value = Math.round(seconds / 60)
      unit = 'minute'
    } else if (Math.abs(seconds) < 86400) {
      value = Math.round(seconds / 3600)
      unit = 'hour'
    } else {
      value = Math.round(seconds / 86400)
      unit = 'day'
    }
    const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(value, unit)
    return `${absolute} (${relative})`
  }

  function formatCredits(credits: SubscriptionCredits): string {
    if (credits.unlimited) return 'Unlimited'
    if (credits.balance === undefined) return 'Balance unavailable'
    return typeof credits.balance === 'number'
      ? new Intl.NumberFormat().format(credits.balance)
      : String(credits.balance)
  }

  return reactive({ usageState, toggleUsageDetails, fetchSubscriptionUsage, useSubscriptionReset,
    titleCase, clampPercent, formatPercent, formatResetTime, formatCredits,
    remove: (name: string) => { delete subscriptionUsage[name] }
  })
}
export type SubscriptionUsageDashboard = ReturnType<typeof useSubscriptionUsage>
