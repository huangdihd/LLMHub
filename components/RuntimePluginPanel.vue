<template>
  <UAlert v-if="loadError" color="red" title="Plugin panel could not be loaded." />
  <iframe v-else-if="documentHTML"
    ref="frame"
    :key="source"
    :srcdoc="documentHTML"
    :title="panel.title"
    sandbox="allow-scripts"
    referrerpolicy="no-referrer"
    credentialless
    class="w-full border-0"
    :style="{ height: `${height}px` }"
    @load="notifyTheme"
  />
</template>

<script setup lang="ts">
import { PANEL_CHANNEL, validatePanelMessage, type RuntimePanel } from '~/shared/dashboard/plugin-panel'

const props = defineProps<{ pluginId: string; panel: RuntimePanel }>()
const frame = ref<HTMLIFrameElement | null>(null)
const height = ref(320)
const colorMode = useColorMode()
const source = computed(() => `/api/hub/plugins/${encodeURIComponent(props.pluginId)}/panels/${encodeURIComponent(props.panel.id)}`)
const documentHTML = ref('')
const loadError = ref(false)
const requests = new Map<string, AbortController>()
let generation = 0

function reset() {
  generation++
  for (const controller of requests.values()) controller.abort()
  requests.clear()
  height.value = 320
}

function notifyTheme() {
  frame.value?.contentWindow?.postMessage({ channel: PANEL_CHANNEL, type: 'theme', theme: colorMode.value === 'dark' ? 'dark' : 'light' }, '*')
}

async function receive(event: MessageEvent) {
  const target = frame.value?.contentWindow
  const message = validatePanelMessage(event, target, props.pluginId)
  if (!message || !target) return
  if (message.type === 'ready') {
    reset()
    notifyTheme()
    return
  }
  if (message.type === 'height') {
    height.value = message.height
    return
  }
  if (requests.has(message.requestId)) return
  if (requests.size >= 32) {
    target.postMessage({ channel: PANEL_CHANNEL, type: 'response', requestId: message.requestId, ok: false, error: 'Too many panel requests' }, '*')
    return
  }
  const controller = new AbortController()
  const currentGeneration = generation
  requests.set(message.requestId, controller)
  const timer = setTimeout(() => controller.abort(), 25000)
  const respond = (response: Record<string, unknown>) => {
    if (generation !== currentGeneration || frame.value?.contentWindow !== target) return
    target.postMessage({ channel: PANEL_CHANNEL, type: 'response', requestId: message.requestId, ...response }, '*')
  }
  try {
    const data = await $fetch(message.path, {
      method: message.method,
      // The host supplies JSON only; plugins cannot override headers, credentials, or redirects.
      body: message.body === undefined ? undefined : JSON.stringify(message.body),
      headers: message.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      redirect: 'error',
      retry: 0,
      signal: controller.signal
    })
    respond({ ok: true, data })
  } catch {
    respond({ ok: false, error: 'Plugin request failed' })
  } finally {
    clearTimeout(timer)
    if (requests.get(message.requestId) === controller) requests.delete(message.requestId)
  }
}

watch(source, async (url, previous, onCleanup) => {
  reset()
  documentHTML.value = ''
  loadError.value = false
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  try {
    // Fetch as the authenticated host; the credentialless frame receives HTML, never cookies.
    const html = await $fetch<string>(url, { responseType: 'text', credentials: 'same-origin', redirect: 'error', signal: controller.signal })
    if (!controller.signal.aborted) documentHTML.value = html
  } catch {
    if (!controller.signal.aborted) loadError.value = true
  }
}, { immediate: true, flush: 'sync' })
watch(() => colorMode.value, notifyTheme)
onMounted(() => window.addEventListener('message', receive))
onBeforeUnmount(() => {
  window.removeEventListener('message', receive)
  reset()
})
</script>
