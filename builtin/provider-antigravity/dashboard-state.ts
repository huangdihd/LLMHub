import { computed, reactive, ref } from 'vue'
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
  const aiCreditsSaving = reactive<Record<string, boolean>>({})

  const antigravityConnectLabel = computed(() => {
    if (activeLogin.value?.status === 'failed') return 'Try again'
    if (editingProvider.value) return 'Reconnect'
    return 'Connect Google'
  })
  const loginMinutesRemaining = computed(() => activeLogin.value
    ? Math.max(0, Math.ceil((activeLogin.value.expires_at - loginNow.value) / 60000))
    : 0)

  async function setAiCredits(provider: any, enabled: boolean) {
    if (aiCreditsSaving[provider.name]) return
    aiCreditsSaving[provider.name] = true
    try {
      await $fetch(`/api/hub/providers/${encodeURIComponent(provider.name)}`, {
        method: 'PUT',
        body: { use_ai_credits_on_quota_exhausted: enabled }
      })
      provider.connection.use_ai_credits_on_quota_exhausted = enabled
      toast.add({
        title: enabled ? 'Google One AI Credits enabled' : 'Google One AI Credits disabled',
        description: enabled ? 'Paid credits will only be used after explicit free-quota exhaustion.' : undefined,
        color: enabled ? 'amber' : 'gray',
        icon: enabled ? 'i-heroicons-currency-dollar' : 'i-heroicons-information-circle'
      })
    } catch (error: any) {
      if (error?.statusCode === 401) return navigateTo('/login')
      showError(error, 'Unable to update AI Credits usage')
    } finally {
      aiCreditsSaving[provider.name] = false
    }
  }

  async function startAntigravityLogin() {
    if (!validateBasics()) return
    startingLogin.value = true
    try {
      const models = form.use_custom_models ? form.custom_models.filter(model => model.id.trim()) : []
      activeLogin.value = await $fetch<LoginState>('/api/hub/providers/antigravity-login/start' as any, {
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
      showError(error, 'Unable to start Google login')
    } finally {
      startingLogin.value = false
    }
  }

  async function completeAntigravityLogin() {
    if (!activeLogin.value || !authorizationCode.value.trim()) return
    completingLogin.value = true
    try {
      const status = await $fetch<LoginState>(`/api/hub/providers/antigravity-login/${activeLogin.value.login_id}/complete` as any, {
        method: 'POST',
        body: { code: authorizationCode.value.trim() }
      })
      activeLogin.value = status
      if (status.status === 'completed') {
        toast.add({ title: 'Google connected', description: `${form.display_name} is ready to use.`, color: 'green', icon: 'i-heroicons-check-circle' })
        isModalOpen.value = false
        await loadProviders()
      }
    } catch (error: any) {
      if (error?.statusCode === 401) return navigateTo('/login')
      showError(error, 'Unable to complete Google login')
    } finally {
      completingLogin.value = false
    }
  }

  async function cancelActiveLogin() {
    const login = activeLogin.value
    activeLogin.value = null
    if (!login) return
    await $fetch(`/api/hub/providers/antigravity-login/${login.login_id}` as any, { method: 'DELETE' }).catch(() => {})
  }
  function openAuthorizationPage() {
    if (activeLogin.value?.authorization_url) window.open(activeLogin.value.authorization_url, '_blank', 'noopener,noreferrer')
  }

  return {
   state: reactive({ activeLogin, startingLogin, completingLogin, authorizationCode, loginMinutesRemaining, antigravityConnectLabel, startAntigravityLogin, openAuthorizationPage, completeAntigravityLogin, aiCreditsSaving, setAiCredits }),
   pending: () => activeLogin.value?.status === 'pending',
   cancel: cancelActiveLogin,
   reset: () => { activeLogin.value = null; authorizationCode.value = '' }
  }
}
export type DashboardState = ReturnType<typeof createDashboard>['state']
