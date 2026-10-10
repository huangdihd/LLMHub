<template>
              <UFormGroup label="Codex client version" help="Sent to OpenAI when fetching the subscription model catalog.">
                <UInput v-model="form.client_version" placeholder="0.149.0" />
              </UFormGroup>

</template>
<script setup lang="ts">
import type { DashboardProviderForm } from '~/shared/dashboard/providers'
defineProps<{ form: DashboardProviderForm }>()
</script>
