<template>
  <StatCard icon="i-heroicons-chart-bar" tone="orange" label="API calls" :value="totalApiCalls.toLocaleString()" :loading="loading" />
</template>

<script setup lang="ts">
defineProps<{ loading: boolean; totalApiCalls: number }>()
</script>
