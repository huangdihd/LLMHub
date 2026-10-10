<template>
  <UCard :ui="{ body: { padding: 'p-5 sm:p-5' } }">
    <div class="flex items-center gap-4">
      <div class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg" :class="tones[tone]">
        <UIcon :name="icon" class="w-5 h-5" />
      </div>
      <div class="min-w-0">
        <p class="text-sm text-gray-500 dark:text-gray-400 truncate">{{ label }}</p>
        <p class="mt-0.5 flex items-baseline gap-1.5">
          <span class="text-2xl font-semibold tabular-nums text-gray-900 dark:text-white">
            <USkeleton v-if="loading" class="h-7 w-12 inline-block align-middle" />
            <template v-else>{{ value }}</template>
          </span>
          <span v-if="hint && !loading" class="text-sm text-gray-500 dark:text-gray-400 truncate">{{ hint }}</span>
        </p>
      </div>
    </div>
  </UCard>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  icon: string
  label: string
  value?: string | number
  hint?: string
  loading?: boolean
  tone?: 'orange' | 'blue' | 'green' | 'purple'
}>(), { tone: 'blue' })

const tones = {
  orange: 'bg-orange-100 text-orange-600 dark:bg-orange-500/10 dark:text-orange-400',
  blue: 'bg-blue-100 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400',
  green: 'bg-green-100 text-green-600 dark:bg-green-500/10 dark:text-green-400',
  purple: 'bg-purple-100 text-purple-600 dark:bg-purple-500/10 dark:text-purple-400'
}
</script>
