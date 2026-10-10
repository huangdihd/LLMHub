<template>
      <UCard class="mb-6">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-medium text-gray-900 dark:text-white flex items-center gap-2">
              <UIcon name="i-heroicons-globe-alt" class="w-5 h-5 text-primary" />
              SSRF Protection
            </h3>
            <UToggle v-model="ssrfConfig.enabled" />
          </div>
        </template>

        <div class="space-y-4">
          <p class="text-sm text-gray-500 dark:text-gray-400">
            Prevent Server-Side Request Forgery by restricting provider base URLs to approved domains. Internal/private IPs (localhost, 10.x, 192.168.x, etc.) are always blocked.
          </p>

          <UFormGroup label="Allowed Hosts" help="One hostname per line (e.g. api.openai.com). Leave empty to allow all public hosts.">
            <UTextarea v-model="ssrfAllowedHostsText" :disabled="!ssrfConfig.enabled" placeholder="api.openai.com&#10;api.anthropic.com&#10;generativelanguage.googleapis.com" :rows="4" />
          </UFormGroup>

          <div class="flex justify-end">
            <UButton color="primary" @click="saveSSRFConfig" :loading="savingSSRF">
              Save Configuration
            </UButton>
          </div>
        </div>
      </UCard>

</template>

<script setup lang="ts">
defineProps<{ ssrfConfig: { enabled: boolean; allowed_hosts: string[] }; savingSSRF: boolean; saveSSRFConfig: () => Promise<unknown> }>()
const ssrfAllowedHostsText = defineModel<string>('allowedHostsText', { required: true })
</script>
