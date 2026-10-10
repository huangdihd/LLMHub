<template>
          <div v-if="record.allowed_providers.length > 0">
            <span class="text-gray-500 dark:text-gray-400">Providers:</span>
            <div class="flex flex-wrap gap-1 mt-1">
              <UBadge v-for="p in record.allowed_providers" :key="p" color="blue" variant="soft">{{ p }}</UBadge>
            </div>
          </div>
          <div v-if="record.allowed_models.length > 0">
            <span class="text-gray-500 dark:text-gray-400">Models:</span>
            <div class="flex flex-wrap gap-1 mt-1">
              <UBadge v-for="m in record.allowed_models" :key="m" color="purple" variant="soft">{{ m }}</UBadge>
            </div>
          </div>
          <p v-if="record.allowed_providers.length === 0 && record.allowed_models.length === 0" class="text-gray-400 italic">
            Access to all providers and models
          </p>
</template>

<script setup lang="ts">
import type { AccessRecord } from '../dashboard-api-key'
defineProps<{ record: AccessRecord }>()
</script>
