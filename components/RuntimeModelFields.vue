<template>
  <div v-if="available" class="flex items-center gap-1.5">
    <RuntimeContributionFields ref="fields" location="models" :record-id="recordId" compact />
    <UButton color="gray" variant="ghost" size="xs" icon="i-heroicons-check" aria-label="Save plugin model fields" :loading="saving" @click="save" />
  </div>
</template>

<script setup lang="ts">
import { useRuntimePluginContributions } from '~/composables/useRuntimePluginContributions'
import RuntimeContributionFields from '~/components/RuntimeContributionFields.vue'

const props = defineProps<{ recordId: string }>()
const runtime = useRuntimePluginContributions()
const available = computed(() => runtime.plugins.value.some(plugin => plugin.contributes.models?.length))
const saving = ref(false)
const fields = ref<InstanceType<typeof RuntimeContributionFields> | null>(null)
const toast = useToast()

async function save() {
  if (saving.value || !fields.value?.validate()) return
  saving.value = true
  try {
    await fields.value.save(props.recordId)
    toast.add({ title: 'Plugin fields saved', color: 'green' })
  } catch (error) {
    toast.add({ title: 'Unable to save plugin fields', description: error instanceof Error ? error.message : undefined, color: 'red' })
  } finally { saving.value = false }
}
</script>
