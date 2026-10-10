<template>
  <div class="px-4 py-4 sm:px-6">
    <div class="flex items-center justify-between gap-3">
      <p class="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-white">
        <span class="h-2 w-2 rounded-full" :class="dots[tone]" />{{ label }}
      </p>
      <UButton color="gray" variant="ghost" size="xs" :icon="copied ? 'i-heroicons-check' : 'i-heroicons-clipboard-document'" :aria-label="`Copy ${label} base URL`" @click="copy" />
    </div>
    <code class="mt-2 block rounded-md bg-gray-100 dark:bg-gray-800 px-3 py-2 font-mono text-xs text-gray-800 dark:text-gray-200 select-all break-all">{{ url }}</code>
    <p class="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-gray-500 dark:text-gray-400">
      <span v-for="route in routes" :key="route">{{ route }}</span>
    </p>
  </div>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{ label: string; path: string; routes: string[]; tone?: 'green' | 'orange' | 'blue' }>(), { tone: 'green' })
const dots = { green: 'bg-green-500', orange: 'bg-orange-500', blue: 'bg-blue-500' }
const toast = useToast()
const url = ref(props.path)
const copied = ref(false)
onMounted(() => { url.value = `${window.location.origin}${props.path}` })

function copy() {
  navigator.clipboard.writeText(url.value).then(() => {
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  }).catch(() => {
    toast.add({ title: 'Copy failed', description: 'Please copy manually', color: 'red', timeout: 2000 })
  })
}
</script>
