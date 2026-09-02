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
          <!-- Desktop nav -->
          <div class="hidden md:flex items-center space-x-2">
            <UButton v-for="link in navLinks" :key="link.to" :to="link.to" variant="ghost" color="gray">
              {{ link.label }}
            </UButton>
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
          <!-- Mobile controls -->
          <div class="flex md:hidden items-center gap-1">
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
            <UButton
              :icon="mobileMenuOpen ? 'i-heroicons-x-mark' : 'i-heroicons-bars-3'"
              color="gray"
              variant="ghost"
              aria-label="Menu"
              @click="mobileMenuOpen = !mobileMenuOpen"
            />
          </div>
        </div>
        <!-- Mobile menu -->
        <div v-if="mobileMenuOpen" class="md:hidden pb-4 border-t border-gray-200 dark:border-gray-700 pt-2 space-y-1">
          <UButton
            v-for="link in navLinks"
            :key="link.to"
            :to="link.to"
            variant="ghost"
            color="gray"
            block
            class="justify-start"
          >
            {{ link.label }}
          </UButton>
          <UButton
            v-if="!authenticated"
            to="/login"
            variant="ghost"
            color="gray"
            block
            class="justify-start"
            icon="i-heroicons-lock-closed"
          >
            Login
          </UButton>
          <UButton
            v-else
            color="gray"
            variant="ghost"
            block
            class="justify-start"
            icon="i-heroicons-arrow-right-on-rectangle"
            @click="doLogout"
          >
            Logout
          </UButton>
        </div>
      </UContainer>
    </nav>
    <slot />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'

const navLinks = [
  { label: 'Home', to: '/' },
  { label: 'Models', to: '/models' },
  { label: 'API Keys', to: '/api-keys' },
  { label: 'Providers', to: '/providers' },
  { label: 'Security', to: '/security' },
  { label: 'Thinking', to: '/thinking' },
  { label: 'Chat', to: '/chat' },
]

const mobileMenuOpen = ref(false)
const route = useRoute()
watch(() => route.fullPath, () => { mobileMenuOpen.value = false })

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
