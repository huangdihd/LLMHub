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
    @load="loaded"
  />
  <div v-if="externalRequest" role="dialog" aria-label="Open external link" class="mt-3 rounded-lg bg-amber-50 dark:bg-amber-400/10 ring-1 ring-inset ring-amber-500/30 p-4">
    <p class="text-sm font-medium text-amber-800 dark:text-amber-300">This plugin wants to open an external website</p>
    <p class="mt-1 text-sm text-amber-700 dark:text-amber-200/80">Continue only if you recognise and trust this address.</p>
    <code class="mt-3 block rounded-md bg-white dark:bg-gray-900 px-3 py-2 font-mono text-xs text-gray-900 dark:text-white whitespace-pre-wrap break-all select-text" dir="ltr">{{ externalRequest.url }}</code>
    <div class="mt-3 flex justify-end gap-2">
      <UButton color="gray" variant="ghost" @click="finishExternal(false)">Cancel</UButton>
      <UButton icon="i-heroicons-arrow-top-right-on-square" @click="finishExternal(true)">Open in a new tab</UButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { PANEL_CHANNEL, acquireExternalLink, releaseExternalLink, panelContext, panelExternalURL, validatePanelMessage, type RuntimePanel, type PanelProviderContext } from '~/shared/dashboard/plugin-panel'

const props = defineProps<{ pluginId: string; panel: RuntimePanel; provider?: PanelProviderContext }>()
const frame = ref<HTMLIFrameElement | null>(null)
const height = ref(320)
const colorMode = useColorMode()
const source = computed(() => `/api/hub/plugins/${encodeURIComponent(props.pluginId)}/panels/${encodeURIComponent(props.panel.id)}`)
const documentHTML = ref('')
const loadError = ref(false)
const requests = new Map<string, AbortController>()
let generation = 0
const externalRequest = ref<{ requestId: string; url: string; target: Window; generation: number } | null>(null)
let externalTimer: ReturnType<typeof setTimeout> | undefined
const externalLinkOwner = {}

function finishExternal(approved: boolean) {
  const request = externalRequest.value
  externalRequest.value = null
  releaseExternalLink(externalLinkOwner)
  clearTimeout(externalTimer)
  if (!request || request.generation !== generation || frame.value?.contentWindow !== request.target) return
  const url = panelExternalURL(request.url)
  if (approved && url) window.open(url, '_blank', 'noopener,noreferrer')
  request.target.postMessage({ channel: PANEL_CHANNEL, type: 'response', requestId: request.requestId, ok: true, data: !!(approved && url) }, '*')
}

function reset() {
  finishExternal(false)
  generation++
  for (const controller of requests.values()) controller.abort()
  requests.clear()
  height.value = 320
}

function loaded() {
  // A frame can navigate itself while retaining the same WindowProxy.
  finishExternal(false)
  notifyTheme()
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
  if (requests.has(message.requestId) || externalRequest.value?.requestId === message.requestId) return
  if (message.type === 'context') {
    target.postMessage({ channel: PANEL_CHANNEL, type: 'response', requestId: message.requestId, ok: true, data: panelContext(props.panel, props.provider) }, '*')
    return
  }
  if (message.type === 'openExternal') {
    if (externalRequest.value || !acquireExternalLink(externalLinkOwner)) {
      target.postMessage({ channel: PANEL_CHANNEL, type: 'response', requestId: message.requestId, ok: false, error: 'An external link request is already pending' }, '*')
      return
    }
    externalRequest.value = { requestId: message.requestId, url: message.url, target, generation }
    externalTimer = setTimeout(() => finishExternal(false), 25000)
    return
  }
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
watch(() => [props.provider?.name, props.provider?.type, props.panel.providerType], reset, { flush: 'sync' })
watch(() => colorMode.value, notifyTheme)
onMounted(() => window.addEventListener('message', receive))
onBeforeUnmount(() => {
  window.removeEventListener('message', receive)
  reset()
})
</script>
