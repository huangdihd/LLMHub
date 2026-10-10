<template>
          <!-- Fallback Strategy -->
          <UCard :ui="{ body: { padding: 'p-4' }, ring: 'ring-1 ring-gray-200 dark:ring-gray-700' }">
            <template #header>
              <div class="flex items-center justify-between">
                <div><p class="text-sm font-medium text-gray-900 dark:text-white">Fallback model</p><p class="mt-0.5 text-xs font-normal text-gray-500 dark:text-gray-400">One model name that tries a list of real models in order.</p></div>
                <UToggle v-model="form.fallbackEnabled" />
              </div>
            </template>

            <div v-if="form.fallbackEnabled" class="space-y-4">
              <UFormGroup label="Model name" help="The name clients send to use the fallback list.">
                <UInput v-model="form.fallbackName" placeholder="auto" />
              </UFormGroup>

              <UFormGroup help="Tried from top to bottom. The first available model handles the request.">
                <template #label>
                  <span>Order</span>
                </template>
                <div class="space-y-2">
                  <div v-for="(entry, i) in form.fallbackPriority" :key="i" class="flex items-center gap-2">
                    <span class="text-xs text-gray-400 w-6 text-right">{{ i + 1 }}.</span>
                    <USelectMenu
                      v-model="form.fallbackPriority[i]"
                      :options="filteredModelOptions"
                      searchable
                      placeholder="Pick model"
                      value-attribute="id"
                      option-attribute="label"
                      class="flex-1"
                    >
                      <template #label>
                        <span v-if="!form.fallbackPriority[i]" class="text-gray-400">Pick model</span>
                        <span v-else class="font-mono text-sm">{{ form.fallbackPriority[i] }}</span>
                      </template>
                    </USelectMenu>
                    <UButton color="red" variant="ghost" icon="i-heroicons-trash" size="xs" @click="form.fallbackPriority.splice(i, 1)" />
                  </div>
                  <div class="flex gap-2">
                    <UButton color="gray" variant="soft" size="sm" icon="i-heroicons-plus" class="dark:!bg-gray-800 dark:!text-gray-100 dark:hover:!bg-gray-700" @click="form.fallbackPriority.push('')">Add model</UButton>
                  </div>
                </div>
              </UFormGroup>
            </div>
          </UCard>
</template>

<script setup lang="ts">
import type { FallbackForm } from '../dashboard-api-key'
import type { AccessCatalog } from '../../access-control/dashboard-api-key'
const props = defineProps<{ form: FallbackForm; catalog: AccessCatalog }>()
const { filteredModelOptions } = props.catalog
</script>
