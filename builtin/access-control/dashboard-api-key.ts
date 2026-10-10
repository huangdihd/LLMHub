import { computed, reactive, ref, type ComputedRef } from 'vue'
import type { ApiKeyDashboardExtension } from '../../shared/dashboard/api-keys'
import ApiKeyAccessDetails from './components/ApiKeyAccessDetails.vue'
import ApiKeyAccessEditor from './components/ApiKeyAccessEditor.vue'

export interface AccessRecord {
  allowed_providers: string[]
  allowed_models: string[]
}
export interface AccessForm {
  selectedProviders: string[]
  selectedModels: string[]
}
export interface AccessCatalog {
  providerOptions: ComputedRef<{ id: string; label: string }[]>
  filteredModelOptions: ComputedRef<{ id: string; name: string; provider: string; label: string }[]>
}
export const accessCatalog = Symbol('API key access catalog')

export default {
  id: 'access-control',
  order: 10,
  create(context) {
    const form = reactive<AccessForm>({ selectedProviders: [], selectedModels: [] })
    const availableProviders = ref<{ name: string; display_name: string }[]>([])
    const availableModels = ref<{ id: string; name: string; provider: string }[]>([])
    const catalog: AccessCatalog = {
      providerOptions: computed(() => availableProviders.value.map(provider => ({
        id: provider.name, label: `${provider.display_name} (${provider.name})`
      }))),
      filteredModelOptions: computed(() => {
        let models = availableModels.value
        if (form.selectedProviders.length > 0) {
          const selected = new Set(form.selectedProviders)
          models = models.filter(model => selected.has(model.provider))
        }
        return models.map(model => ({ ...model, label: model.id }))
      })
    }
    context.set(accessCatalog, catalog)
    return {
      sections: [
        { id: 'access-details', slot: 'details', order: 10, component: ApiKeyAccessDetails, props: record => ({ record }) },
        { id: 'access-editor', slot: 'editor', order: 20, component: ApiKeyAccessEditor, props: () => ({ form, catalog }) }
      ],
      async load() {
        const [providersData, modelsData] = await Promise.all([
          $fetch('/api/hub/providers').catch(() => ({ providers: [] })),
          $fetch('/api/hub/models').catch(() => ({ models: [] }))
        ])
        availableProviders.value = providersData.providers || []
        availableModels.value = modelsData.models || []
      },
      reset(record) {
        const access = record as unknown as AccessRecord | undefined
        form.selectedProviders = [...(access?.allowed_providers || [])]
        form.selectedModels = [...(access?.allowed_models || [])]
      },
      payload: () => ({ allowed_providers: form.selectedProviders, allowed_models: form.selectedModels })
    }
  }
} satisfies ApiKeyDashboardExtension
