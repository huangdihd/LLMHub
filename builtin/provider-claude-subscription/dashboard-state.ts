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

  const claudeConnectLabel = computed(() => {
    if (activeLogin.value?.status === 'failed') return 'Try again'
    if (editingProvider.value) return 'Reconnect'
    return 'Connect Claude'
  })
  const loginMinutesRemaining = computed(() => activeLogin.value
    ? Math.max(0, Math.ceil((activeLogin.value.expires_at - loginNow.value) / 60000))
    : 0)

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
   state: reactive({ activeLogin, startingLogin, completingLogin, authorizationCode, loginMinutesRemaining, claudeConnectLabel, startClaudeLogin, openAuthorizationPage, completeClaudeLogin }),
   pending: () => activeLogin.value?.status === 'pending',
   cancel: cancelActiveLogin,
   reset: () => { activeLogin.value = null; authorizationCode.value = '' }
  }
}
export type DashboardState = ReturnType<typeof createDashboard>['state']
