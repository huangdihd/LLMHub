<template>
          <!-- Model Quotas -->
          <UFormGroup help="Monthly token limit for individual models. 0 means no limit.">
            <template #label>
              <span>Model limits</span>
            </template>
            <div class="space-y-2">
              <div v-for="(entry, i) in form.modelQuotaList" :key="i" class="flex items-center gap-2">
                <USelectMenu
                  v-model="entry.model"
                  :options="filteredModelOptions"
                  searchable
                  placeholder="Pick model"
                  value-attribute="id"
                  option-attribute="label"
                  class="flex-1"
                >
                  <template #label>
                    <span v-if="!entry.model" class="text-gray-400">Pick model</span>
                    <span v-else class="font-mono text-sm">{{ entry.model }}</span>
                  </template>
                </USelectMenu>
                <UInput v-model.number="entry.limit" type="number" min="0" step="10000" placeholder="Limit" class="w-24 sm:w-32" />
                <UButton color="red" variant="ghost" icon="i-heroicons-trash" @click="form.modelQuotaList.splice(i, 1)" />
              </div>
              <UButton color="gray" variant="soft" size="sm" icon="i-heroicons-plus" class="dark:!bg-gray-800 dark:!text-gray-100 dark:hover:!bg-gray-700" @click="form.modelQuotaList.push({ model: '', limit: 0 })">Add model limit</UButton>
            </div>
          </UFormGroup>

          <!-- Provider Quotas -->
          <UFormGroup help="Monthly token limit for individual providers. 0 means no limit.">
            <template #label>
              <span>Provider limits</span>
            </template>
            <div class="space-y-2">
              <div v-for="(entry, i) in form.providerQuotaList" :key="i" class="flex items-center gap-2">
                <USelectMenu
                  v-model="entry.provider"
                  :options="providerOptions"
                  searchable
                  placeholder="Pick provider"
                  value-attribute="id"
                  option-attribute="label"
                  class="flex-1"
                >
                  <template #label>
                    <span v-if="!entry.provider" class="text-gray-400">Pick provider</span>
                    <span v-else class="font-mono text-sm">{{ entry.provider }}</span>
                  </template>
                </USelectMenu>
                <UInput v-model.number="entry.limit" type="number" min="0" step="100000" placeholder="Limit" class="w-24 sm:w-32" />
                <UButton color="red" variant="ghost" icon="i-heroicons-trash" @click="form.providerQuotaList.splice(i, 1)" />
              </div>
              <UButton color="gray" variant="soft" size="sm" icon="i-heroicons-plus" class="dark:!bg-gray-800 dark:!text-gray-100 dark:hover:!bg-gray-700" @click="form.providerQuotaList.push({ provider: '', limit: 0 })">Add provider limit</UButton>
            </div>
          </UFormGroup>
</template>

<script setup lang="ts">
import type { QuotaForm } from '../dashboard-api-key'
import type { AccessCatalog } from '../../access-control/dashboard-api-key'
const props = defineProps<{ form: QuotaForm; catalog: AccessCatalog }>()
const { providerOptions, filteredModelOptions } = props.catalog
</script>
