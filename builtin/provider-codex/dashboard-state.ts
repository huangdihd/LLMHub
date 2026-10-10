import { computed, onBeforeUnmount, reactive, ref } from 'vue'
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
export function createDashboard(context: DashboardProviderContext) {
  const { form, editingProvider, isModalOpen, validateBasics, loadProviders, showError } = context
  const toast = useToast()
  const startingLogin = ref(false)
  const completingLogin = ref(false)
  const activeLogin = ref<LoginState | null>(null)
  const authorizationCode = ref('')
  const loginNow = ref(Date.now())
  const autoResetSaving = reactive<Record<string, boolean>>({})
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  const codexConnectLabel = computed(() => {
    if (activeLogin.value?.status === 'failed') return 'Try again'
    if (editingProvider.value) return 'Reconnect'
    return 'Connect ChatGPT'
  })
  const loginMinutesRemaining = computed(() => activeLogin.value
    ? Math.max(0, Math.ceil((activeLogin.value.expires_at - loginNow.value) / 60000))
    : 0)

  onBeforeUnmount(stopPolling)

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
   state: reactive({ activeLogin, startingLogin, completingLogin, authorizationCode, loginMinutesRemaining, codexConnectLabel, startCodexLogin, openVerificationPage, copyLoginCode, autoResetSaving, setAutoReset }),
   pending: () => activeLogin.value?.status === 'pending',
   cancel: cancelActiveLogin,
   reset: () => { stopPolling(); activeLogin.value = null; authorizationCode.value = '' }
  }
}
export type DashboardState = ReturnType<typeof createDashboard>['state']
