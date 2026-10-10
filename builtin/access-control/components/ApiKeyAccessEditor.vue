<template>
          <!-- Allowed Providers -->
          <UFormGroup help="Leave empty to allow every provider.">
            <template #label>
              <div class="flex items-center justify-between w-full">
                <span>Allowed providers</span>
                <UBadge v-if="form.selectedProviders.length > 0" color="blue" variant="soft" size="xs">
                  {{ form.selectedProviders.length }} selected
                </UBadge>
              </div>
            </template>
            <USelectMenu
              v-model="form.selectedProviders"
              :options="providerOptions"
              multiple
              searchable
              placeholder="All providers"
              value-attribute="id"
              option-attribute="label"
            >
              <template #label>
                <span v-if="form.selectedProviders.length === 0" class="text-gray-400">All providers</span>
                <span v-else>{{ form.selectedProviders.length }} provider{{ form.selectedProviders.length !== 1 ? 's' : '' }}</span>
              </template>
            </USelectMenu>
          </UFormGroup>

          <!-- Allowed Models (filtered by selected providers) -->
          <UFormGroup :help="form.selectedProviders.length > 0 ? 'Only models from the providers selected above are listed.' : 'Leave empty to allow every model.'">
            <template #label>
              <div class="flex items-center justify-between w-full">
                <span>Allowed models</span>
                <UBadge v-if="form.selectedModels.length > 0" color="purple" variant="soft" size="xs">
                  {{ form.selectedModels.length }} selected
                </UBadge>
              </div>
            </template>
            <USelectMenu
              v-model="form.selectedModels"
              :options="filteredModelOptions"
              multiple
              searchable
              placeholder="All models"
              value-attribute="id"
              option-attribute="label"
              option-group-attribute="provider"
            >
              <template #label>
                <span v-if="form.selectedModels.length === 0" class="text-gray-400">All models</span>
                <span v-else>{{ form.selectedModels.length }} model{{ form.selectedModels.length !== 1 ? 's' : '' }}</span>
              </template>
              <template #option="{ option }">
                <div class="flex items-center justify-between w-full">
                  <span class="font-mono text-sm">{{ option.name }}</span>
                  <UBadge color="gray" variant="soft" size="xs">{{ option.provider }}</UBadge>
                </div>
              </template>
            </USelectMenu>
          </UFormGroup>
</template>

<script setup lang="ts">
import type { AccessForm, AccessCatalog } from '../dashboard-api-key'
const props = defineProps<{ form: AccessForm; catalog: AccessCatalog }>()
const { providerOptions, filteredModelOptions } = props.catalog
</script>
