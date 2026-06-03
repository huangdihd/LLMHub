<template>
  <UContainer class="py-6 max-w-4xl">
    <UCard class="flex flex-col h-[calc(100vh-8rem)]" :ui="{ body: { base: 'flex-1 overflow-hidden flex flex-col', padding: 'p-0 sm:p-0' } }">
      <template #header>
        <div class="space-y-3">
          <!-- Auth Selection -->
          <div class="flex items-center gap-2">
            <USelectMenu
              v-model="selectedAuthId"
              :options="authOptions"
              value-attribute="id"
              option-attribute="label"
              class="w-48"
              @update:model-value="onAuthModeChange"
            >
              <template #leading>
                <UIcon name="i-heroicons-shield-check" class="w-4 h-4 text-primary" />
              </template>
            </USelectMenu>
            
            <UInput
              v-if="selectedAuthId === 'custom'"
              v-model="apiKey"
              type="password"
              placeholder="Enter Custom API Key"
              icon="i-heroicons-key"
              class="flex-1"
              size="sm"
              @update:model-value="onApiKeyChange"
            />
            <div v-else class="flex-1 flex items-center px-3 py-1 bg-gray-50 dark:bg-gray-900 rounded border border-gray-200 dark:border-gray-800 text-xs text-gray-500 italic">
              {{ selectedAuthId === 'session' ? 'Using Admin Session Permissions' : 'Using Pre-defined Token Permissions' }}
            </div>

            <UBadge v-if="apiKey || selectedAuthId === 'session'" color="green" variant="soft" size="sm">Auth Set</UBadge>
            <UBadge v-else color="gray" variant="soft" size="sm">Auth Required</UBadge>
          </div>
          <!-- Model + Endpoint -->
          <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <USelectMenu
              v-model="selectedModel"
              :options="models"
              value-attribute="id"
              option-attribute="id"
              placeholder="Select a model"
              class="w-full sm:w-64"
              searchable
            />
            <div class="flex items-center gap-4 w-full sm:w-auto">
              <USelectMenu
                v-model="selectedEndpoint"
                :options="endpoints"
                value-attribute="value"
                option-attribute="label"
                class="flex-1 sm:w-64"
              />
              <UCheckbox v-model="useStream" label="Stream" />
            </div>
          </div>
        </div>
      </template>

      <div ref="chatContainer" class="flex-1 overflow-y-auto p-4 space-y-4">
        <div v-for="(msg, index) in messages" :key="index"
          :class="msg.role === 'user' ? 'text-right' : 'text-left'">
          <div :class="msg.role === 'user'
            ? 'bg-primary-500 text-white'
            : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white'"
            class="inline-block px-4 py-2 rounded-lg max-w-[85%] text-left shadow-sm">
            <div v-if="msg.role === 'user'" class="whitespace-pre-wrap text-sm">{{ msg.content }}</div>
            <div v-else class="markdown-body text-sm" v-html="renderMarkdownWithCursor(msg.content, msg.loading)"></div>
          </div>
        </div>
      </div>

      <template #footer>
        <form @submit.prevent="sendMessage" class="flex gap-2">
          <UInput
            v-model="input"
            placeholder="Type a message..."
            class="flex-1"
            :disabled="isLoading"
            autocomplete="off"
          />
          <UButton
            type="submit"
            color="primary"
            :disabled="!selectedModel || !input || isLoading || (!apiKey && !hasSession)"
            :loading="isLoading"
          >
            Send
          </UButton>
        </form>
      </template>
    </UCard>
  </UContainer>
</template>

<script setup lang="ts">
import { marked } from 'marked'
import { ref, onMounted, nextTick } from 'vue'

const models = ref<any[]>([])
const availableKeys = ref<any[]>([])
const selectedAuthId = ref('session')
const selectedModel = ref('')
const messages = ref<{ role: string; content: string; loading?: boolean }[]>([])
const input = ref('')
const isLoading = ref(false)
const chatContainer = ref<HTMLElement | null>(null)
const useStream = ref(true)
const apiKey = ref('')
const hasSession = ref(false)

const authOptions = computed(() => {
  const opts = []
  if (hasSession.value) {
    opts.push({ label: 'Admin Session', id: 'session' })
  }
  opts.push({ label: 'Custom API Key', id: 'custom' })
  availableKeys.value.forEach(k => {
    opts.push({ label: `Key: ${k.name}`, id: k.id, value: k.key })
  })
  return opts
})

const endpoints = [
  { label: 'OpenAI Chat Completions', value: '/api/openai/chat/completions' },
  { label: 'OpenAI Completions', value: '/api/openai/completions' },
  { label: 'OpenAI Responses', value: '/api/openai/responses' },
  { label: 'Claude Messages', value: '/api/claude/v1/messages' },
  { label: 'Claude Completion', value: '/api/claude/v1/complete' },
]
const selectedEndpoint = ref(endpoints[0].value)

marked.setOptions({ breaks: true, gfm: true })

function renderMarkdownWithCursor(content: string, loading?: boolean): string {
  if (!content) return loading ? '<span class="animate-pulse text-gray-400">|</span>' : ''
  let html = marked.parse(content) as string
  if (loading) {
    html = html.replace(/<\/p>\s*$/, '<span class="animate-pulse text-gray-400">|</span></p>')
    if (!html.includes('</p>')) {
      html += '<span class="animate-pulse text-gray-400">|</span>'
    }
  }
  return html
}

function onAuthModeChange() {
  const opt = authOptions.value.find(o => o.id === selectedAuthId.value)
  if (!opt) return

  if (opt.id === 'session') {
    apiKey.value = ''
  } else if (opt.id === 'custom') {
    const saved = localStorage.getItem('llmhub_api_key')
    apiKey.value = saved || ''
  } else {
    apiKey.value = (opt as any).value
  }
  loadModels()
}

function onApiKeyChange(val: string) {
  if (selectedAuthId.value === 'custom') {
    localStorage.setItem('llmhub_api_key', val)
  }
  loadModels()
}

async function loadModels() {
  try {
    const headers: Record<string, string> = {}
    if (apiKey.value) {
      headers['Authorization'] = `Bearer ${apiKey.value}`
    }

    // If using session (no apiKey) and we have a session, use hub endpoint for all models
    if (!apiKey.value && hasSession.value) {
      const hubRes = await $fetch('/api/hub/models').catch(() => null)
      if (hubRes && (hubRes as any).models) {
        models.value = (hubRes as any).models.map((m: any) => ({ id: m.id }))
        return
      }
    }

    // Otherwise use OpenAI models endpoint (which now supports session cookies too)
    const data = await $fetch('/api/openai/models', { headers })
    models.value = ((data as any).data || []).map((m: any) => ({ id: m.id }))
  } catch (e) {
    console.error('Failed to load models:', e)
    models.value = []
  }
}

onMounted(async () => {
  // 1. Check session status
  try {
    const status = await $fetch('/api/auth/status').catch(() => ({ authenticated: false }))
    hasSession.value = (status as any).authenticated
    
    if (hasSession.value) {
      const keysData = await $fetch('/api/hub/keys').catch(() => ({ keys: [] }))
      availableKeys.value = (keysData as any).keys || []
    }
  } catch {}

  // 2. Initial Auth Mode
  const saved = localStorage.getItem('llmhub_api_key')
  if (saved && !hasSession.value) {
    selectedAuthId.value = 'custom'
    apiKey.value = saved
  } else if (!hasSession.value) {
    selectedAuthId.value = 'custom'
  }
  
  await loadModels()
})

function scrollToBottom() {
  nextTick(() => {
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight
    }
  })
}

function buildRequestBody(history: { role: string; content: string }[]) {
  const ep = selectedEndpoint.value

  if (ep === '/api/openai/completions') {
    const prompt = history.map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`).join('\n') + '\nAssistant:'
    return { model: selectedModel.value, prompt, stream: useStream.value }
  }

  if (ep === '/api/claude/v1/complete') {
    const prompt = history.map(m => `\n\n${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`).join('') + '\n\nAssistant:'
    return { model: selectedModel.value, prompt, max_tokens_to_sample: 4096, stream: useStream.value }
  }

  if (ep === '/api/openai/responses') {
    return { model: selectedModel.value, input: history.map(m => ({ role: m.role, content: m.content })), stream: useStream.value }
  }

  if (ep === '/api/claude/v1/messages') {
    return { model: selectedModel.value, max_tokens: 4096, messages: history.map(m => ({ role: m.role, content: m.content })), stream: useStream.value }
  }

  return { model: selectedModel.value, messages: history.map(m => ({ role: m.role, content: m.content })), stream: useStream.value }
}

function parseStreamContent(chunk: any): string | null {
  if (chunk.choices?.[0]?.delta?.content) return chunk.choices[0].delta.content
  if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') return chunk.delta.text
  return null
}

function parseResponseContent(response: any): string {
  const ep = selectedEndpoint.value
  if (ep === '/api/openai/completions' || ep === '/api/claude/v1/complete') {
    return response.choices?.[0]?.text || response.completion || ''
  }
  if (ep === '/api/openai/responses') {
    const output = response.output?.[0]
    if (output?.content?.[0]?.text) return output.content[0].text
    if (response.output_text) return response.output_text
    return ''
  }
  if (ep === '/api/claude/v1/messages') {
    return response.content?.[0]?.text || ''
  }
  return response.choices?.[0]?.message?.content || ''
}

async function sendMessage() {
  if (!selectedModel.value || !input.value || isLoading.value || (!apiKey.value && !hasSession.value)) return

  const userMessage = input.value
  messages.value.push({ role: 'user', content: userMessage })
  input.value = ''
  isLoading.value = true

  const assistantIndex = messages.value.length
  messages.value.push({ role: 'assistant', content: '', loading: true })
  scrollToBottom()

  const history = messages.value.slice(0, -1).map(m => ({ role: m.role, content: m.content }))
  const body = buildRequestBody(history)

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (apiKey.value) {
      headers['Authorization'] = `Bearer ${apiKey.value}`
    }

    if (useStream.value) {
      const response = await fetch(selectedEndpoint.value, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      })

      if (!response.ok) {
        const errText = await response.text()
        let errMsg = errText
        try { errMsg = JSON.parse(errText)?.error?.message || errText } catch {}
        throw new Error(errMsg)
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data === '[DONE]') continue
            if (!data) continue

            try {
              const chunk = JSON.parse(data)
              if (chunk.error) {
                const errObj = chunk.error
                const msg = errObj?.error?.message || errObj?.message || (typeof errObj === 'string' ? errObj : JSON.stringify(errObj))
                messages.value[assistantIndex].content = `Error: ${msg}`
                break
              }
              const content = parseStreamContent(chunk)
              if (content) {
                messages.value[assistantIndex].content += content
                scrollToBottom()
              }
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
    } else {
      const response = await $fetch(selectedEndpoint.value, {
        method: 'POST',
        headers,
        body
      })

      messages.value[assistantIndex].content = parseResponseContent(response)
    }

    messages.value[assistantIndex].loading = false
  } catch (error: any) {
    messages.value[assistantIndex].content = `Error: ${error.message}`
    messages.value[assistantIndex].loading = false
  } finally {
    isLoading.value = false
  }
}
</script>

<style>
.markdown-body pre {
  background-color: #1f2937;
  color: #e5e7eb;
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 8px 0;
}

.markdown-body code {
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  font-size: 13px;
}

.markdown-body p {
  margin: 4px 0;
}

.markdown-body ul, .markdown-body ol {
  padding-left: 20px;
  margin: 4px 0;
}

.markdown-body blockquote {
  border-left: 3px solid #6b7280;
  padding-left: 12px;
  margin: 8px 0;
  color: #9ca3af;
}

.markdown-body h1, .markdown-body h2, .markdown-body h3 {
  font-weight: bold;
  margin: 8px 0 4px;
}

.markdown-body h1 { font-size: 1.25em; }
.markdown-body h2 { font-size: 1.125em; }
.markdown-body h3 { font-size: 1em; }

.markdown-body table {
  border-collapse: collapse;
  margin: 8px 0;
}

.markdown-body th, .markdown-body td {
  border: 1px solid #4b5563;
  padding: 6px 12px;
}

.markdown-body th {
  background-color: #374151;
}

.markdown-body a {
  color: #60a5fa;
  text-decoration: underline;
}

.markdown-body img {
  max-width: 100%;
  border-radius: 6px;
}
</style>
