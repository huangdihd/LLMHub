<template>
  <NuxtLink to="/updates" class="text-xs text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300" :title="buildInformation.commit || undefined">
    LLMHub {{ buildInformation.version }}<span v-if="buildInformation.commit"> · {{ buildInformation.commit.slice(0, 7) }}</span>
  </NuxtLink>
</template>

<script setup lang="ts">
import type { SystemBuildInformation } from '~/shared/types/system-update'

const buildInformation = useRuntimeConfig().public.buildInformation as SystemBuildInformation
</script>
