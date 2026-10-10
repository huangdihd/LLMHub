<template>
              <UFormGroup label="Anthropic API version">
                <UInput v-model="form.version" placeholder="2023-06-01" />
              </UFormGroup>

</template>
<script setup lang="ts">
import type { DashboardProviderForm } from '~/shared/dashboard/providers'
defineProps<{ form: DashboardProviderForm }>()
</script>
