<template>
          <section class="rounded-lg border border-gray-200 dark:border-gray-700 p-4 sm:p-5">
            <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div class="flex items-center gap-2">
                  <h4 class="font-medium text-gray-900 dark:text-white">ChatGPT subscription</h4>
                  <UBadge
                    v-if="editingProvider && !activeLogin"
                    :color="editingProvider.connection.authenticated ? 'green' : 'red'"
                    variant="subtle"
                    size="sm"
                  >
                    {{ editingProvider.connection.authenticated ? 'Connected' : 'Not connected' }}
                  </UBadge>
                </div>
                <p class="mt-1 text-sm leading-5 text-gray-500 dark:text-gray-400">
                  Sign in on OpenAI. LLMHub stores the session server-side and refreshes it automatically.
                </p>
              </div>
              <UButton
                v-if="activeLogin?.status !== 'pending'"
                type="button"
                icon="i-heroicons-arrow-top-right-on-square"
                :loading="startingLogin"
                @click="startCodexLogin"
              >
                {{ codexConnectLabel }}
              </UButton>
            </div>

            <div v-if="activeLogin?.status === 'pending'" class="mt-5 border-t border-gray-200 dark:border-gray-700 pt-5">
              <ol class="space-y-4">
                <li class="flex gap-3">
                  <span class="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 text-xs font-medium">1</span>
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-medium text-gray-900 dark:text-white">Open the secure OpenAI sign-in page</p>
                    <UButton class="mt-2" type="button" variant="soft" icon="i-heroicons-arrow-top-right-on-square" @click="openVerificationPage">Open ChatGPT</UButton>
                  </div>
                </li>
                <li class="flex gap-3">
                  <span class="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 text-xs font-medium">2</span>
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-medium text-gray-900 dark:text-white">Enter this one-time code</p>
                    <div class="mt-2 flex items-center gap-2">
                      <code class="rounded-md bg-gray-100 dark:bg-gray-800 px-3 py-2 font-mono text-lg tracking-wider text-gray-900 dark:text-white">{{ activeLogin.user_code }}</code>
                      <UButton type="button" color="gray" variant="ghost" icon="i-heroicons-clipboard-document" aria-label="Copy code" @click="copyLoginCode" />
                    </div>
                  </div>
                </li>
              </ol>
              <div class="mt-5 flex items-center justify-between gap-3 text-sm text-gray-500 dark:text-gray-400">
                <span class="flex items-center gap-2"><UIcon name="i-heroicons-arrow-path" class="w-4 h-4 animate-spin" /> Waiting for confirmation</span>
                <span>Expires in {{ loginMinutesRemaining }} min</span>
              </div>
            </div>

            <UAlert
              v-else-if="activeLogin?.status === 'failed'"
              class="mt-4"
              color="red"
              variant="subtle"
              title="Could not connect ChatGPT"
              :description="activeLogin.error"
            />
          </section>

</template>
<script setup lang="ts">
defineOptions({ inheritAttrs: false })
import { toRefs } from 'vue'
import type { DashboardProviderContext, DashboardProviderRecord } from '~/shared/dashboard/providers'
import type { DashboardState } from '../dashboard-state'
const props = defineProps<{ state: DashboardState; form: DashboardProviderContext['form']; editingProvider: DashboardProviderRecord | null }>()
const { activeLogin, startingLogin, completingLogin, authorizationCode, loginMinutesRemaining, codexConnectLabel, startCodexLogin, openVerificationPage, copyLoginCode } = toRefs(props.state)
</script>
