<template>
  <UCheckbox v-model="form.normalize_cch" label="Normalize cch in the system prompt for upstream cache reuse" />
</template>

<script setup lang="ts">
import type { DashboardProviderForm } from '~/shared/dashboard/providers'
defineProps<{ form: DashboardProviderForm }>()
</script>
