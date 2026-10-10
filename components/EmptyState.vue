<template>
  <div class="text-center" :class="compact ? 'py-6' : 'py-10'">
    <UIcon :name="icon" class="mx-auto text-gray-300 dark:text-gray-600" :class="compact ? 'w-8 h-8' : 'w-10 h-10'" />
    <h3 class="font-medium text-gray-900 dark:text-white" :class="compact ? 'mt-3 text-sm' : 'mt-4'">{{ title }}</h3>
    <p v-if="description" class="mt-1 text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto">{{ description }}</p>
    <div v-if="$slots.default" class="mt-5"><slot /></div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ icon: string; title: string; description?: string; compact?: boolean }>()
</script>
