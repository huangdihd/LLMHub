<template>
  <SettingsCard title="Provider host allowlist" description="Limit provider base URLs to hosts you approve. Private and loopback addresses are always blocked.">
    <template #control><UToggle v-model="ssrfConfig.enabled" aria-label="Provider host allowlist" /></template>

    <UFormGroup label="Allowed hosts" help="One hostname per line. Leave empty to allow any public host.">
      <UTextarea v-model="ssrfAllowedHostsText" :disabled="!ssrfConfig.enabled" placeholder="api.openai.com&#10;api.anthropic.com&#10;generativelanguage.googleapis.com" :rows="4" :ui="{ base: 'font-mono text-sm' }" />
    </UFormGroup>

    <template #footer>
      <UButton :loading="savingSSRF" @click="saveSSRFConfig">Save</UButton>
    </template>
  </SettingsCard>
</template>

<script setup lang="ts">
defineProps<{ ssrfConfig: { enabled: boolean; allowed_hosts: string[] }; savingSSRF: boolean; saveSSRFConfig: () => Promise<unknown> }>()
const ssrfAllowedHostsText = defineModel<string>('allowedHostsText', { required: true })
</script>
