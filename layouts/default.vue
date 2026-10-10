<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors">
    <nav class="sticky top-0 z-30 border-b border-gray-200 dark:border-gray-800 bg-white/80 dark:bg-gray-900/80 backdrop-blur">
      <UContainer class="max-w-5xl">
        <div class="flex justify-between h-14">
          <NuxtLink to="/" class="flex items-center gap-2 flex-shrink-0" aria-label="LLMHub home">
            <img src="/logo.svg" alt="" class="w-7 h-7" />
            <span class="text-lg font-bold text-gray-900 dark:text-white">LLMHub</span>
          </NuxtLink>
          <!-- Desktop nav -->
          <div class="hidden md:flex items-center gap-0.5">
            <NuxtLink
              v-for="link in navLinks" :key="link.to" :to="link.to"
              class="px-2.5 py-1.5 rounded-md text-sm font-medium transition-colors"
              :class="isActive(link.to) ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'"
            >{{ link.label }}</NuxtLink>
            <span class="mx-1.5 h-5 w-px bg-gray-200 dark:bg-gray-800" />
            <UTooltip v-if="authenticated === false" text="Log in">
              <UButton to="/login" variant="ghost" color="gray" icon="i-heroicons-lock-closed" aria-label="Log in" />
            </UTooltip>
            <UTooltip v-else-if="authenticated" text="Log out">
              <UButton color="gray" variant="ghost" icon="i-heroicons-arrow-right-on-rectangle" aria-label="Log out" @click="doLogout" />
            </UTooltip>
            <div v-else class="w-8 h-8" />
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
        <div v-if="mobileMenuOpen" class="md:hidden pb-3 border-t border-gray-200 dark:border-gray-800 pt-2 space-y-0.5">
          <NuxtLink
            v-for="link in navLinks" :key="link.to" :to="link.to"
            class="block px-3 py-2 rounded-md text-sm font-medium"
            :class="isActive(link.to) ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-300'"
          >{{ link.label }}</NuxtLink>
          <NuxtLink v-if="authenticated === false" to="/login" class="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-gray-600 dark:text-gray-300">
            <UIcon name="i-heroicons-lock-closed" class="w-4 h-4" />Log in
          </NuxtLink>
          <button v-else-if="authenticated" type="button" class="flex w-full items-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-gray-600 dark:text-gray-300" @click="doLogout">
            <UIcon name="i-heroicons-arrow-right-on-rectangle" class="w-4 h-4" />Log out
          </button>
        </div>
      </UContainer>
    </nav>
    <slot />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'

const navLinks = useDashboardNavigation()

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

// null until the session check returns, so the nav never flashes the wrong state.
const authenticated = ref<boolean | null>(null)

function isActive(to: string) {
  return to === '/' ? route.path === '/' : route.path === to || route.path.startsWith(`${to}/`)
}

onMounted(async () => {
  try {
    const res = await $fetch('/api/auth/status')
    authenticated.value = !!(res as any).authenticated
  } catch { authenticated.value = false }
})

async function doLogout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  authenticated.value = false
  await navigateTo('/')
}
</script>
