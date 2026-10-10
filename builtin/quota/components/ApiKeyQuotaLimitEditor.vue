<template>
          <!-- Monthly Token Limit -->
          <UFormGroup help="0 means no limit.">
            <template #label>
              <div class="flex items-center justify-between w-full">
                <span>Monthly token limit</span>
                <span class="text-xs text-gray-400 font-normal">{{ form.monthly_limit > 0 ? form.monthly_limit.toLocaleString() + ' tokens a month' : 'No limit' }}</span>
              </div>
            </template>
            <UInput v-model.number="form.monthly_limit" type="number" min="0" step="1000" placeholder="0" />
          </UFormGroup>
</template>

<script setup lang="ts">
import type { QuotaForm } from '../dashboard-api-key'
defineProps<{ form: QuotaForm }>()
</script>
