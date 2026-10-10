<template>
        <UCard>
          <template #header>
            <div class="flex items-center justify-between">
              <h3 class="text-lg font-medium text-gray-900 dark:text-white flex items-center gap-2">
                <UIcon name="i-heroicons-circle-stack" class="w-5 h-5 text-orange-500" />
                Claude Base URL
              </h3>
              <UButton
                color="gray"
                variant="ghost"
                size="xs"
                icon="i-heroicons-clipboard-document"
                @click="copyUrl(claudeBaseUrl)"
              />
            </div>
          </template>
          <div class="space-y-2">
            <code class="block text-sm font-mono bg-gray-100 dark:bg-gray-800 px-3 py-2 rounded select-all break-all">
              {{ claudeBaseUrl }}
            </code>
            <div class="flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
              <UBadge color="gray" variant="soft">/messages</UBadge>
              <UBadge color="gray" variant="soft">/complete</UBadge>
            </div>
          </div>
        </UCard>
</template>

<script setup lang="ts">
const toast = useToast()
const claudeBaseUrl = ref('')
onMounted(() => { claudeBaseUrl.value = `${window.location.origin}/api/claude` })

function copyUrl(url: string) {
  navigator.clipboard.writeText(url).then(() => {
    toast.add({ title: 'Copied!', description: url, icon: 'i-heroicons-check-circle', color: 'green', timeout: 2000 })
  }).catch(() => {
    toast.add({ title: 'Copy failed', description: 'Please copy manually', color: 'red', timeout: 2000 })
  })
}

</script>
