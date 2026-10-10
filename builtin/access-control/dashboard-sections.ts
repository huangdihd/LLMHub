import { ref, reactive } from 'vue'
import { useToast, navigateTo } from '#imports'
import type { DashboardSectionExtension } from '~/shared/dashboard/sections'
import SecuritySSRF from './components/SecuritySSRF.vue'
import SecurityDescription from './components/SecurityDescription.vue'

export default {
  id: 'access-control',
  page: 'security',
  order: 10,
  create() {
    const toast = useToast()
    const savingSSRF = ref(false)
    const ssrfConfig = reactive({
      enabled: false,
      allowed_hosts: [] as string[]
    })

    const ssrfAllowedHostsText = ref('')

    async function saveSSRFConfig() {
      savingSSRF.value = true
      try {
        const hosts = ssrfAllowedHostsText.value
          .split('\n')
          .map(h => h.trim())
          .filter(h => h.length > 0)

        await $fetch('/api/hub/security', {
          method: 'PUT',
          body: {
            ssrf: {
              enabled: ssrfConfig.enabled,
              allowed_hosts: hosts
            }
          }
        })
        ssrfConfig.allowed_hosts = hosts
        toast.add({ title: 'Saved', description: 'SSRF protection updated', icon: 'i-heroicons-check-circle', color: 'green', timeout: 2000 })
      } catch (e: any) {
        if (e?.statusCode === 401) return navigateTo('/login')
        toast.add({ title: 'Error', description: 'Failed to save SSRF config', color: 'red' })
      } finally {
        savingSSRF.value = false
      }
    }

    return {
      sections: [{ id: 'security-description', slot: 'description', order: 0, component: SecurityDescription, props: () => ({}) }, {
        id: 'ssrf', slot: 'after-login', order: 0, component: SecuritySSRF,
        props: () => ({ ssrfConfig, savingSSRF: savingSSRF.value, saveSSRFConfig, allowedHostsText: ssrfAllowedHostsText.value, 'onUpdate:allowedHostsText': (value: string) => { ssrfAllowedHostsText.value = value } })
      }],
      hydrate(data) {
        const ssrf = data.ssrf || {}
        ssrfConfig.enabled = ssrf.enabled ?? false
        ssrfConfig.allowed_hosts = ssrf.allowed_hosts ?? []
        ssrfAllowedHostsText.value = (ssrf.allowed_hosts || []).join('\n')
      }
    }
  }
} satisfies DashboardSectionExtension
