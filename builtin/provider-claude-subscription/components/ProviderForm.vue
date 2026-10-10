<template>
          <section class="rounded-lg border border-gray-200 dark:border-gray-700 p-4 sm:p-5">
            <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div class="flex items-center gap-2">
                  <h4 class="font-medium text-gray-900 dark:text-white">Claude Code subscription</h4>
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
                  Sign in on Anthropic, then paste the authorization code shown there.
                </p>
              </div>
              <UButton
                v-if="activeLogin?.status !== 'pending'"
                type="button"
                icon="i-heroicons-arrow-top-right-on-square"
                :loading="startingLogin"
                @click="startClaudeLogin"
              >
                {{ claudeConnectLabel }}
              </UButton>
            </div>

            <div v-if="activeLogin?.status === 'pending'" class="mt-5 space-y-4 border-t border-gray-200 dark:border-gray-700 pt-5">
              <UButton type="button" variant="soft" icon="i-heroicons-arrow-top-right-on-square" @click="openAuthorizationPage">Open Anthropic</UButton>
              <UFormGroup label="Authorization code" help="Paste the code displayed after authorizing LLMHub.">
                <div class="flex flex-col gap-2 sm:flex-row">
                  <UInput v-model="authorizationCode" class="flex-1" placeholder="Paste authorization code" autocomplete="off" @keyup.enter="completeClaudeLogin" />
                  <UButton type="button" :loading="completingLogin" :disabled="!authorizationCode.trim()" @click="completeClaudeLogin">Complete connection</UButton>
                </div>
              </UFormGroup>
              <div class="flex items-center justify-between gap-3 text-sm text-gray-500 dark:text-gray-400">
                <span>Waiting for authorization code</span>
                <span>Expires in {{ loginMinutesRemaining }} min</span>
              </div>
            </div>

            <UAlert
              v-else-if="activeLogin?.status === 'failed'"
              class="mt-4"
              color="red"
              variant="subtle"
              title="Could not connect Claude"
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
const { activeLogin, startingLogin, completingLogin, authorizationCode, loginMinutesRemaining, claudeConnectLabel, startClaudeLogin, openAuthorizationPage, completeClaudeLogin } = toRefs(props.state)
</script>
