<template>
  <UContainer class="py-3 sm:py-6 max-w-5xl px-2 sm:px-6">
    <UCard class="flex flex-col h-[calc(100dvh-5.5rem)] sm:h-[calc(100dvh-7rem)]" :ui="{ body: { base: 'flex-1 overflow-hidden flex flex-col', padding: 'p-0 sm:p-0' }, header: { padding: 'px-3 py-3 sm:px-4 sm:py-3' }, footer: { padding: 'px-3 py-3 sm:px-4 sm:py-3' } }">
      <template #header>
        <div class="flex flex-col gap-2 lg:flex-row lg:items-center">
          <!-- Model + Endpoint -->
          <USelectMenu
            v-model="selectedModel"
            :options="models"
            value-attribute="id"
            option-attribute="id"
            placeholder="Select a model"
            class="w-full lg:w-64"
            searchable
          >
            <template #leading>
              <UIcon name="i-heroicons-cpu-chip" class="w-4 h-4 text-gray-400" />
            </template>
          </USelectMenu>
          <div class="flex items-center gap-3 lg:flex-1">
            <USelectMenu
              v-model="selectedEndpoint"
              :options="endpoints"
              value-attribute="value"
              option-attribute="label"
              class="flex-1 min-w-0 lg:flex-none lg:w-56"
            />
            <UCheckbox v-if="!isGeminiEndpoint" v-model="useStream" label="Stream" class="flex-shrink-0" />
            <span v-else class="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">{{ isGeminiStream ? 'Always streams' : 'Never streams' }}</span>
          </div>
          <!-- Auth Selection -->
          <div class="flex items-center gap-2">
            <USelectMenu
              v-model="selectedAuthId"
              :options="authOptions"
              value-attribute="id"
              option-attribute="label"
              class="flex-1 min-w-0 lg:flex-none lg:w-44"
              @update:model-value="onAuthModeChange"
            >
              <template #leading>
                <UIcon name="i-heroicons-key" class="w-4 h-4" :class="apiKey || selectedAuthId === 'session' ? 'text-primary-500' : 'text-amber-500'" />
              </template>
            </USelectMenu>
            <UInput
              v-if="selectedAuthId === 'custom'"
              v-model="apiKey"
              type="password"
              placeholder="API key"
              class="flex-1 min-w-0 lg:flex-none lg:w-40"
              @update:model-value="onApiKeyChange"
            />
            <UTooltip text="Clear the conversation">
              <UButton color="gray" variant="ghost" icon="i-heroicons-trash" aria-label="Clear the conversation" :disabled="isLoading || messages.length === 0" @click="messages = []" />
            </UTooltip>
          </div>
        </div>
      </template>

      <div ref="chatContainer" class="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
        <div v-if="messages.length === 0" class="h-full flex items-center justify-center">
          <EmptyState
            icon="i-heroicons-chat-bubble-left-right"
            :title="selectedModel ? 'Say something to the model' : 'Pick a model to start'"
            :description="!apiKey && !hasSession ? 'You also need to log in or enter an API key.' : 'Requests go through the gateway exactly as a client\'s would.'"
          />
        </div>
        <div v-for="(msg, index) in messages" :key="index"
          :class="msg.role === 'user' ? 'text-right' : 'text-left'">
          <div :class="msg.role === 'user'
            ? 'bg-primary-500 text-white dark:text-gray-900 rounded-2xl rounded-br-md'
            : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white rounded-2xl rounded-bl-md'"
            class="inline-block px-4 py-2.5 max-w-[85%] text-left">
            <div v-if="msg.role === 'user'" class="whitespace-pre-wrap text-sm">{{ msg.content }}</div>
            <div v-else>
              <details v-if="msg.thinking" class="mb-2">
                <summary class="text-xs text-gray-400 cursor-pointer hover:text-gray-600 dark:hover:text-gray-300 select-none">
                  Thinking
                </summary>
                <div class="mt-1 text-xs text-gray-400 dark:text-gray-500 border-l-2 border-gray-300 dark:border-gray-600 pl-2 whitespace-pre-wrap markdown-body" v-html="renderMarkdownWithCursor(msg.thinking)"></div>
              </details>
              <div class="markdown-body text-sm" v-html="renderMarkdownWithCursor(msg.content, msg.loading)"></div>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <form @submit.prevent="sendMessage" class="flex items-end gap-2">
          <UTextarea
            v-model="input"
            placeholder="Message"
            class="flex-1"
            :rows="1"
            autoresize
            :maxrows="8"
            :disabled="isLoading"
            autocomplete="off"
            @keydown.enter.exact="onEnter"
          />
          <UButton
            type="submit"
            icon="i-heroicons-paper-airplane"
            aria-label="Send"
            :disabled="!selectedModel || !input || isLoading || (!apiKey && !hasSession)"
            :loading="isLoading"
          />
        </form>
        <p class="mt-1.5 text-xs text-gray-400 dark:text-gray-500 hidden sm:block">Enter to send, Shift+Enter for a new line.</p>
      </template>
    </UCard>
  </UContainer>
</template>

<script setup lang="ts">
import { marked } from 'marked'
import { ref, computed, onMounted, nextTick } from 'vue'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI } from '@google/genai'

const isGeminiEndpoint = computed(() =>
  selectedEndpoint.value === 'gemini-generate' || selectedEndpoint.value === 'gemini-stream'
)
const isGeminiStream = computed(() => selectedEndpoint.value === 'gemini-stream')
const effectiveStream = computed(() =>
  isGeminiEndpoint.value ? isGeminiStream.value : useStream.value
)

const models = ref<any[]>([])
const availableKeys = ref<any[]>([])
const selectedAuthId = ref('session')
const selectedModel = ref('')
const messages = ref<{ role: string; content: string; thinking?: string; loading?: boolean }[]>([])
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
    opts.push({ label: `Key: ${k.name}`, id: k.id })
  })
  return opts
})

const endpoints = [
  { label: 'OpenAI Chat Completions', value: '/api/openai/chat/completions' },
  { label: 'OpenAI Completions', value: '/api/openai/completions' },
  { label: 'OpenAI Responses', value: '/api/openai/responses' },
  { label: 'Claude Messages', value: '/api/claude/v1/messages' },
  { label: 'Claude Completion', value: '/api/claude/v1/complete' },
  { label: 'Gemini generateContent', value: 'gemini-generate' },
  { label: 'Gemini streamGenerateContent', value: 'gemini-stream' },
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
  if (selectedAuthId.value === 'custom') {
    const saved = localStorage.getItem('llmhub_api_key')
    apiKey.value = saved || ''
  } else {
    apiKey.value = ''
  }
  loadModels()
}

function onApiKeyChange(val: string) {
  if (selectedAuthId.value === 'custom') {
    localStorage.setItem('llmhub_api_key', val)
  }
  loadModels()
}

// Typing an API key fires one request per keystroke; only the latest
// request may write the result, or a stale 401 can wipe a fresh list
let loadModelsSeq = 0
async function loadModels() {
  const seq = ++loadModelsSeq
  try {
    const headers: Record<string, string> = {}

    if (selectedAuthId.value !== 'session' && selectedAuthId.value !== 'custom') {
      headers['X-LLMHub-Key-ID'] = selectedAuthId.value
    } else if (apiKey.value) {
      headers['Authorization'] = `Bearer ${apiKey.value}`
    }

    // If using session and no impersonation/custom key, try hub models first
    if (selectedAuthId.value === 'session' && hasSession.value) {
      const hubRes = await $fetch('/api/hub/models').catch(() => null)
      if (seq !== loadModelsSeq) return
      if (hubRes && (hubRes as any).models) {
        models.value = (hubRes as any).models.map((m: any) => ({ id: m.id }))
        return
      }
    }

    const data = await $fetch('/api/openai/models', { headers })
    if (seq !== loadModelsSeq) return
    models.value = ((data as any).data || []).map((m: any) => ({ id: m.id }))
  } catch (e) {
    if (seq !== loadModelsSeq) return
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

// ---- SDK clients ------------------------------------------------------------
// The playground talks to the gateway through the official SDKs, so every
// message doubles as an SDK-compatibility check of the gateway itself.
// In session/impersonation modes the SDK auth header is suppressed so the
// admin cookie (plus optional X-LLMHub-Key-ID) authenticates instead.

function extraHeaders(): Record<string, string> {
  const h: Record<string, string> = {}
  if (selectedAuthId.value !== 'session' && selectedAuthId.value !== 'custom') {
    h['X-LLMHub-Key-ID'] = selectedAuthId.value
  }
  return h
}

function makeOpenAIClient(): OpenAI {
  const custom = selectedAuthId.value === 'custom'
  return new OpenAI({
    baseURL: `${location.origin}/api/openai`,
    apiKey: custom ? apiKey.value : 'session',
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      ...(custom ? {} : { Authorization: null }),
      ...extraHeaders()
    } as Record<string, string | null>
  })
}

function makeClaudeClient(): Anthropic {
  const custom = selectedAuthId.value === 'custom'
  return new Anthropic({
    baseURL: `${location.origin}/api/claude`,
    apiKey: custom ? apiKey.value : 'session',
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      ...(custom ? {} : { 'x-api-key': null }),
      ...extraHeaders()
    } as Record<string, string | null>
  })
}

function makeGeminiClient(): GoogleGenAI {
  const custom = selectedAuthId.value === 'custom'
  // An empty apiKey passes the SDK's browser check but never becomes a
  // x-goog-api-key header, so the session cookie authenticates instead
  return new GoogleGenAI({
    apiKey: custom ? apiKey.value : '',
    httpOptions: {
      baseUrl: `${location.origin}/api/gemini`,
      headers: extraHeaders()
    }
  })
}

// Enter confirms an IME candidate while composing (e.g. Chinese input); only send otherwise.
function onEnter(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  sendMessage()
}

async function sendMessage() {
  if (!selectedModel.value || !input.value || isLoading.value) return
  if (selectedAuthId.value === 'custom' && !apiKey.value && !hasSession.value) return

  const userMessage = input.value
  messages.value.push({ role: 'user', content: userMessage })
  input.value = ''
  isLoading.value = true

  const idx = messages.value.length
  messages.value.push({ role: 'assistant', content: '', loading: true })
  scrollToBottom()

  const history = messages.value.slice(0, -1).map(m => ({ role: m.role, content: m.content }))

  const appendContent = (t?: string | null) => {
    if (!t) return
    messages.value[idx].content += t
    scrollToBottom()
  }
  const appendThinking = (t?: string | null) => {
    if (!t) return
    messages.value[idx].thinking = (messages.value[idx].thinking || '') + t
    scrollToBottom()
  }

  try {
    const ep = selectedEndpoint.value
    const model = selectedModel.value

    if (ep === '/api/openai/chat/completions') {
      const client = makeOpenAIClient()
      if (effectiveStream.value) {
        const stream = await client.chat.completions.create({ model, messages: history as any, stream: true })
        for await (const chunk of stream) {
          const delta: any = chunk.choices[0]?.delta
          appendThinking(delta?.reasoning_content)
          appendContent(delta?.content)
        }
      } else {
        const r = await client.chat.completions.create({ model, messages: history as any })
        const msg: any = r.choices[0]?.message
        appendThinking(msg?.reasoning_content)
        appendContent(msg?.content)
      }
    } else if (ep === '/api/openai/completions') {
      const client = makeOpenAIClient()
      const prompt = history.map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`).join('\n') + '\nAssistant:'
      if (effectiveStream.value) {
        const stream = await client.completions.create({ model, prompt, max_tokens: 4096, stream: true })
        for await (const chunk of stream) {
          appendContent(chunk.choices[0]?.text)
        }
      } else {
        const r = await client.completions.create({ model, prompt, max_tokens: 4096 })
        appendContent(r.choices[0]?.text)
      }
    } else if (ep === '/api/openai/responses') {
      const client = makeOpenAIClient()
      const inputItems = history.map(m => ({ role: m.role, content: m.content }))
      if (effectiveStream.value) {
        const stream = await client.responses.create({ model, input: inputItems as any, stream: true })
        for await (const ev of stream) {
          if (ev.type === 'response.output_text.delta') appendContent(ev.delta)
          else if (ev.type === 'response.reasoning_summary_text.delta') appendThinking((ev as any).delta)
        }
      } else {
        const r = await client.responses.create({ model, input: inputItems as any })
        const reasoning: any = r.output.find((i: any) => i.type === 'reasoning')
        appendThinking((reasoning?.summary || []).map((s: any) => s.text).join(''))
        appendContent(r.output_text)
      }
    } else if (ep === '/api/claude/v1/messages') {
      const client = makeClaudeClient()
      if (effectiveStream.value) {
        const stream = client.messages.stream({ model, max_tokens: 4096, messages: history as any })
        for await (const ev of stream) {
          if (ev.type === 'content_block_delta') {
            const d: any = ev.delta
            if (d.type === 'text_delta') appendContent(d.text)
            else if (d.type === 'thinking_delta') appendThinking(d.thinking)
          }
        }
      } else {
        const r = await client.messages.create({ model, max_tokens: 4096, messages: history as any })
        appendThinking(r.content.filter((b: any) => b.type === 'thinking').map((b: any) => b.thinking).join(''))
        appendContent(r.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''))
      }
    } else if (ep === '/api/claude/v1/complete') {
      const client = makeClaudeClient()
      const prompt = history.map(m => `\n\n${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`).join('') + '\n\nAssistant:'
      if (effectiveStream.value) {
        const stream = await client.completions.create({ model, prompt, max_tokens_to_sample: 4096, stream: true })
        for await (const chunk of stream) {
          appendContent(chunk.completion)
        }
      } else {
        const r = await client.completions.create({ model, prompt, max_tokens_to_sample: 4096 })
        appendContent(r.completion)
      }
    } else {
      // gemini-generate / gemini-stream
      const client = makeGeminiClient()
      const contents = history.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }))
      const consumeParts = (parts: any[]) => {
        for (const part of parts) {
          if (part.thought && part.text) appendThinking(part.text)
          else if (part.text) appendContent(part.text)
        }
      }
      if (isGeminiStream.value) {
        const stream = await client.models.generateContentStream({ model, contents, config: { maxOutputTokens: 4096 } })
        for await (const chunk of stream) {
          consumeParts(chunk.candidates?.[0]?.content?.parts || [])
        }
      } else {
        const r = await client.models.generateContent({ model, contents, config: { maxOutputTokens: 4096 } })
        consumeParts(r.candidates?.[0]?.content?.parts || [])
      }
    }

    messages.value[idx].loading = false
  } catch (error: any) {
    messages.value[idx].content = `Error: ${error.message}`
    messages.value[idx].loading = false
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
