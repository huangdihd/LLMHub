<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-900 transition-colors">
    <nav class="bg-white dark:bg-gray-800 shadow border-b border-gray-200 dark:border-gray-700">
      <UContainer>
        <div class="flex justify-between h-16">
          <div class="flex items-center">
            <h1 class="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <UIcon name="i-heroicons-cube-transparent" class="w-6 h-6" />
              LLMHub
            </h1>
          </div>
          <div class="flex items-center space-x-2">
            <UButton to="/" variant="ghost" color="gray">Home</UButton>
            <UButton to="/models" variant="ghost" color="gray">Models</UButton>
            <UButton to="/api-keys" variant="ghost" color="gray">API Keys</UButton>
            <UButton to="/providers" variant="ghost" color="gray">Providers</UButton>
            <UButton to="/chat" variant="ghost" color="gray">Chat</UButton>
            <UButton v-if="!authenticated" to="/login" variant="ghost" color="gray" icon="i-heroicons-lock-closed">
              Login
            </UButton>
            <UButton v-else color="gray" variant="ghost" icon="i-heroicons-arrow-right-on-rectangle" @click="doLogout">
              Logout
            </UButton>
            <ClientOnly>
              <UButton
                :icon="isDark ? 'i-heroicons-moon-20-solid' : 'i-heroicons-sun-20-solid'"
                color="gray"
                variant="ghost"
                aria-label="Theme"
                @click="isDark = !isDark"
              />
              <template #fallback>
                <div class="w-8 h-8" />
              </template>
            </ClientOnly>
          </div>
        </div>
      </UContainer>
    </nav>
    <slot />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const colorMode = useColorMode()
const isDark = computed({
  get () {
    return colorMode.value === 'dark'
  },
  set () {
    colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
  }
})

const authenticated = ref(false)

onMounted(async () => {
  try {
    const res = await $fetch('/api/auth/status')
    authenticated.value = (res as any).authenticated
  } catch {}
})

async function doLogout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  authenticated.value = false
  await navigateTo('/')
}
</script>
