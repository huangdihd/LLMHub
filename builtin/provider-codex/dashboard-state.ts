import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { DashboardProviderContext } from '~/shared/dashboard/providers'
type LoginState = {
  login_id: string
  status: 'pending' | 'completed' | 'failed' | 'cancelled'
  verification_url?: string
  user_code?: string
  authorization_url?: string
  expires_at: number
  error?: string
}
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


export function createDashboard(context: DashboardProviderContext) {
  const { form, editingProvider, isModalOpen, validateBasics, loadProviders, showError } = context
  const toast = useToast()
  const startingLogin = ref(false)
  const completingLogin = ref(false)
  const activeLogin = ref<LoginState | null>(null)
  const authorizationCode = ref('')
  const loginNow = ref(Date.now())
  const usageNow = ref(Date.now())
  const subscriptionUsage = reactive<Record<string, SubscriptionUsageState>>({})
  const autoResetSaving = reactive<Record<string, boolean>>({})
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let usageClockTimer: ReturnType<typeof setInterval> | null = null

  const codexConnectLabel = computed(() => {
    if (activeLogin.value?.status === 'failed') return 'Try again'
    if (editingProvider.value) return 'Reconnect'
    return 'Connect ChatGPT'
  })
  const loginMinutesRemaining = computed(() => activeLogin.value
    ? Math.max(0, Math.ceil((activeLogin.value.expires_at - loginNow.value) / 60000))
    : 0)

  onMounted(() => {
    usageClockTimer = setInterval(() => { usageNow.value = Date.now() }, 60000)
  })
  onBeforeUnmount(() => {
    stopPolling()
    if (usageClockTimer) clearInterval(usageClockTimer)
  })
  function usageState(name: string): SubscriptionUsageState {
    if (!subscriptionUsage[name]) {
      subscriptionUsage[name] = { loading: false, resettingCreditId: '', error: '', data: null, expanded: false }
    }
    return subscriptionUsage[name]
  }

  async function setAutoReset(provider: any, enabled: boolean) {
    if (autoResetSaving[provider.name]) return
    autoResetSaving[provider.name] = true
    try {
      await $fetch(`/api/hub/providers/${encodeURIComponent(provider.name)}`, {
        method: 'PUT',
        body: { auto_reset_on_quota_exhausted: enabled }
      })
      provider.connection.auto_reset_on_quota_exhausted = enabled
      toast.add({
        title: enabled ? 'Automatic reset enabled' : 'Automatic reset disabled',
        color: enabled ? 'green' : 'gray',
        icon: enabled ? 'i-heroicons-check-circle' : 'i-heroicons-information-circle'
      })
    } catch (error: any) {
      if (error?.statusCode === 401) return navigateTo('/login')
      showError(error, 'Unable to update automatic reset')
    } finally {
      autoResetSaving[provider.name] = false
    }
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
    if (!confirm(`Use this ${title}? This will reset your eligible weekly and 5-hour usage limits.`)) return

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
        description: messages[result.code] || `OpenAI returned: ${result.code}`,
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

  async function startCodexLogin() {
    if (!validateBasics()) return
    startingLogin.value = true
    try {
      const models = form.use_custom_models ? form.custom_models.filter(model => model.id.trim()) : []
      activeLogin.value = await $fetch<LoginState>('/api/hub/providers/codex-login/start' as any, {
        method: 'POST',
        body: {
          name: form.name, display_name: form.display_name, enabled: form.enabled,
          normalize_cch: form.normalize_cch, timeout: form.timeout,
          enable_timeout: form.enable_timeout, max_retries: form.max_retries,
          use_custom_models: form.use_custom_models, models,
          client_version: form.client_version,
          reconnect: Boolean(editingProvider.value)
        }
      })
      loginNow.value = Date.now()
      schedulePoll()
    } catch (error: any) {
      showError(error, 'Unable to start ChatGPT login')
    } finally {
      startingLogin.value = false
    }
  }

  function schedulePoll() {
    stopPolling()
    pollTimer = setTimeout(pollLogin, 1500)
  }

  async function pollLogin() {
    if (!activeLogin.value || activeLogin.value.status !== 'pending') return
    loginNow.value = Date.now()
    try {
      const status = await $fetch<LoginState>(`/api/hub/providers/codex-login/${activeLogin.value.login_id}/poll` as any, { method: 'POST' })
      activeLogin.value = status
      if (status.status === 'completed') {
        toast.add({ title: 'ChatGPT connected', description: `${form.display_name} is ready to use.`, color: 'green', icon: 'i-heroicons-check-circle' })
        stopPolling()
        isModalOpen.value = false
        await loadProviders()
        return
      }
      if (status.status === 'failed') {
        stopPolling()
        return
      }
      schedulePoll()
    } catch (error: any) {
      if (error?.statusCode === 401) return navigateTo('/login')
      schedulePoll()
    }
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  async function cancelActiveLogin() {
    stopPolling()
    const login = activeLogin.value
    activeLogin.value = null
    if (!login) return
    await $fetch(`/api/hub/providers/codex-login/${login.login_id}` as any, { method: 'DELETE' }).catch(() => {})
  }
  function openVerificationPage() {
    if (activeLogin.value?.verification_url) window.open(activeLogin.value.verification_url, '_blank', 'noopener,noreferrer')
  }

  async function copyLoginCode() {
    if (!activeLogin.value?.user_code) return
    await navigator.clipboard.writeText(activeLogin.value.user_code)
    toast.add({ title: 'Code copied', color: 'green', timeout: 1500 })
  }

  return {
   state: reactive({ activeLogin, startingLogin, completingLogin, authorizationCode, loginMinutesRemaining, codexConnectLabel, startCodexLogin, openVerificationPage, copyLoginCode, usageState, titleCase, fetchSubscriptionUsage, formatPercent, clampPercent, formatResetTime, formatCredits, autoResetSaving, setAutoReset, useSubscriptionReset, toggleUsageDetails }),
   pending: () => activeLogin.value?.status === 'pending',
   cancel: cancelActiveLogin,
   reset: () => { stopPolling(); activeLogin.value = null; authorizationCode.value = '' },
   remove: (name: string) => { delete subscriptionUsage[name] }
  }
}
export type DashboardState = ReturnType<typeof createDashboard>['state']
