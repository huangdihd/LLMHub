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
  let usageClockTimer: ReturnType<typeof setInterval> | null = null

  const claudeConnectLabel = computed(() => {
    if (activeLogin.value?.status === 'failed') return 'Try again'
    if (editingProvider.value) return 'Reconnect'
    return 'Connect Claude'
  })
  const loginMinutesRemaining = computed(() => activeLogin.value
    ? Math.max(0, Math.ceil((activeLogin.value.expires_at - loginNow.value) / 60000))
    : 0)

  onMounted(() => {
    usageClockTimer = setInterval(() => { usageNow.value = Date.now() }, 60000)
  })
  onBeforeUnmount(() => {
    if (usageClockTimer) clearInterval(usageClockTimer)
  })
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

  async function startClaudeLogin() {
    if (!validateBasics()) return
    startingLogin.value = true
    try {
      const models = form.use_custom_models ? form.custom_models.filter(model => model.id.trim()) : []
      activeLogin.value = await $fetch<LoginState>('/api/hub/providers/claude-login/start' as any, {
        method: 'POST',
        body: {
          name: form.name, display_name: form.display_name, enabled: form.enabled,
          normalize_cch: form.normalize_cch, timeout: form.timeout,
          enable_timeout: form.enable_timeout, max_retries: form.max_retries,
          use_custom_models: form.use_custom_models, models,
          reconnect: Boolean(editingProvider.value)
        }
      })
      authorizationCode.value = ''
      loginNow.value = Date.now()
      openAuthorizationPage()
    } catch (error: any) {
      showError(error, 'Unable to start Claude login')
    } finally {
      startingLogin.value = false
    }
  }

  async function completeClaudeLogin() {
    if (!activeLogin.value || !authorizationCode.value.trim()) return
    completingLogin.value = true
    try {
      const status = await $fetch<LoginState>(`/api/hub/providers/claude-login/${activeLogin.value.login_id}/complete` as any, {
        method: 'POST',
        body: { code: authorizationCode.value.trim() }
      })
      activeLogin.value = status
      if (status.status === 'completed') {
        toast.add({ title: 'Claude connected', description: `${form.display_name} is ready to use.`, color: 'green', icon: 'i-heroicons-check-circle' })
        isModalOpen.value = false
        await loadProviders()
      }
    } catch (error: any) {
      if (error?.statusCode === 401) return navigateTo('/login')
      showError(error, 'Unable to complete Claude login')
    } finally {
      completingLogin.value = false
    }
  }

  async function cancelActiveLogin() {
    const login = activeLogin.value
    activeLogin.value = null
    if (!login) return
    await $fetch(`/api/hub/providers/claude-login/${login.login_id}` as any, { method: 'DELETE' }).catch(() => {})
  }
  function openAuthorizationPage() {
    if (activeLogin.value?.authorization_url) window.open(activeLogin.value.authorization_url, '_blank', 'noopener,noreferrer')
  }

  return {
   state: reactive({ activeLogin, startingLogin, completingLogin, authorizationCode, loginMinutesRemaining, claudeConnectLabel, startClaudeLogin, openAuthorizationPage, completeClaudeLogin, usageState, titleCase, fetchSubscriptionUsage, formatPercent, clampPercent, formatResetTime, formatCredits, toggleUsageDetails }),
   pending: () => activeLogin.value?.status === 'pending',
   cancel: cancelActiveLogin,
   reset: () => { activeLogin.value = null; authorizationCode.value = '' },
   remove: (name: string) => { delete subscriptionUsage[name] }
  }
}
export type DashboardState = ReturnType<typeof createDashboard>['state']
