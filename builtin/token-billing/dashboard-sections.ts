import { ref } from 'vue'
import { useToast, navigateTo } from '#imports'
import type { DashboardSectionExtension } from '~/shared/dashboard/sections'
import ModelTokenRatios from './components/ModelTokenRatios.vue'
import ModelBillingDescription from './components/ModelBillingDescription.vue'

export default {
  id: 'token-billing',
  page: 'models',
  order: 0,
  create() {
    const toast = useToast()
    const savedRatios = ref<Record<string, TokenRatioValues>>({})
    const savingRatio = ref('')

    interface TokenRatioValues {
      input: number
      output: number
      cached: number
    }

    function decorateModels(modelList: any[]): any[] {
      return modelList.map(model => {
        const ratios = savedRatios.value[model.id] || { input: 1, output: 1, cached: 1 }
        return {
          ...model,
          tokenRatios: {
            input: String(ratios.input * 100),
            output: String(ratios.output * 100),
            cached: String(ratios.cached * 100)
          }
        }
      })
    }

    function isRatioDirty(model: any): boolean {
      const saved = savedRatios.value[model.id] || { input: 1, output: 1, cached: 1 }
      return Number(model.tokenRatios.input) !== saved.input * 100
        || Number(model.tokenRatios.output) !== saved.output * 100
        || Number(model.tokenRatios.cached) !== saved.cached * 100
    }

    async function saveRatios(model: any) {
      const percentages = {
        input: Number(model.tokenRatios.input),
        output: Number(model.tokenRatios.output),
        cached: Number(model.tokenRatios.cached)
      }
      if (Object.values(percentages).some(value => !Number.isFinite(value) || value < 0 || value > 10000)) {
        toast.add({ title: 'Invalid ratio', description: 'Each billing ratio must be between 0% and 10000%.', color: 'red' })
        return
      }

      savingRatio.value = model.id
      try {
        const ratios = { ...savedRatios.value }
        const modelRatios = {
          input: percentages.input / 100,
          output: percentages.output / 100,
          cached: percentages.cached / 100
        }
        if (Object.values(modelRatios).every(value => value === 1)) delete ratios[model.id]
        else ratios[model.id] = modelRatios

        const data = await $fetch('/api/hub/model-token-ratios', { method: 'PUT', body: { ratios } })
        savedRatios.value = (data as any).settings.ratios || {}
        toast.add({ title: 'Billing ratios saved', description: model.id, icon: 'i-heroicons-check-circle', color: 'green', timeout: 2000 })
      } catch (e: any) {
        if (e?.statusCode === 401) return navigateTo('/login')
        toast.add({ title: 'Unable to save billing ratios', description: e?.data?.message, color: 'red' })
      } finally {
        savingRatio.value = ''
      }
    }


    return {
      sections: [
        { id: 'billing-description', slot: 'description', order: 0, component: ModelBillingDescription, props: () => ({}) },
        { id: 'billing-ratios', slot: 'model-actions', order: 0, component: ModelTokenRatios, props: model => ({ model, savingRatio: savingRatio.value, isRatioDirty, saveRatios }) }
      ],
      async load() {
        const data = await $fetch('/api/hub/model-token-ratios')
        savedRatios.value = (data as any).ratios || {}
      },
      decorate: model => decorateModels([model])[0]
    }
  }
} satisfies DashboardSectionExtension
