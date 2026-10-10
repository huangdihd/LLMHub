<template>
  <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
    <div class="min-w-0">
      <h2 class="text-2xl font-bold text-gray-900 dark:text-white">{{ title }}</h2>
      <p v-if="description || $slots.description" class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        <slot name="description">{{ description }}</slot>
      </p>
    </div>
    <div v-if="$slots.default" class="flex flex-wrap items-center gap-2 self-start sm:self-auto sm:flex-nowrap sm:flex-shrink-0">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ title: string; description?: string }>()
</script>
