<template>
        <UCard>
          <template #header>
            <div class="flex items-center justify-between">
              <h3 class="text-lg font-medium text-gray-900 dark:text-white flex items-center gap-2">
                <UIcon name="i-heroicons-circle-stack" class="w-5 h-5 text-blue-500" />
                Gemini Base URL
              </h3>
              <UButton
                color="gray"
                variant="ghost"
                size="xs"
                icon="i-heroicons-clipboard-document"
                @click="copyUrl(geminiBaseUrl)"
              />
            </div>
          </template>
          <div class="space-y-2">
            <code class="block text-sm font-mono bg-gray-100 dark:bg-gray-800 px-3 py-2 rounded select-all break-all">
              {{ geminiBaseUrl }}
            </code>
            <div class="flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
              <UBadge color="gray" variant="soft">/models</UBadge>
              <UBadge color="gray" variant="soft">/:model/generateContent</UBadge>
              <UBadge color="gray" variant="soft">/:model/streamGenerateContent</UBadge>
            </div>
          </div>
        </UCard>
</template>

<script setup lang="ts">
const toast = useToast()
const geminiBaseUrl = ref('')
onMounted(() => { geminiBaseUrl.value = `${window.location.origin}/api/gemini` })

function copyUrl(url: string) {
  navigator.clipboard.writeText(url).then(() => {
    toast.add({ title: 'Copied!', description: url, icon: 'i-heroicons-check-circle', color: 'green', timeout: 2000 })
  }).catch(() => {
    toast.add({ title: 'Copy failed', description: 'Please copy manually', color: 'red', timeout: 2000 })
  })
}

</script>
