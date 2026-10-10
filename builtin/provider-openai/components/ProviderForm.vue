<template>
          <section class="space-y-4">
            <UFormGroup label="API protocol">
              <USelect v-model="form.api_type" :options="[
                { value: 'responses', label: 'Responses (default)' },
                { value: 'chat_completions', label: 'Chat Completions' }
              ]" />
            </UFormGroup>
            <UFormGroup label="Base URL" required :error="errors.base_url" help="The root URL for this provider's API.">
              <UInput v-model="form.base_url" :placeholder="baseUrl" />
            </UFormGroup>
            <UFormGroup label="API key" :required="!editingProvider" :error="errors.api_key" :help="editingProvider ? 'Leave empty to keep the current key.' : 'Stored on the LLMHub server and never returned to the browser.'">
              <UInput v-model="form.api_key" type="password" autocomplete="new-password" :placeholder="editingProvider ? 'Keep current key' : keyPlaceholder" />
            </UFormGroup>
          </section>

</template>
<script setup lang="ts">
defineOptions({ inheritAttrs: false })
import type { DashboardProviderContext } from '~/shared/dashboard/providers'
defineProps<{ form: DashboardProviderContext['form']; errors: Record<string, string>; editingProvider: DashboardProviderContext['editingProvider']['value'] }>()
const baseUrl = "https://api.openai.com/v1"
const keyPlaceholder = "sk-\u2026"
</script>
