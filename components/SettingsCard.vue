<template>
  <UCard>
    <template #header>
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <h3 class="font-medium text-gray-900 dark:text-white">{{ title }}</h3>
          <p v-if="description" class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{{ description }}</p>
        </div>
        <div v-if="$slots.control" class="flex-shrink-0 pt-0.5"><slot name="control" /></div>
      </div>
    </template>
    <slot />
    <template v-if="$slots.footer" #footer>
      <div class="flex justify-end gap-2"><slot name="footer" /></div>
    </template>
  </UCard>
</template>

<script setup lang="ts">
defineProps<{ title: string; description?: string }>()
</script>
