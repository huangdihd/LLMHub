<template>
  <div v-if="compact" class="flex items-center gap-2.5">
    <label v-for="field in fields" :key="field.key" class="flex items-center gap-1.5 text-xs whitespace-nowrap" :class="errors[field.key] ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'" :title="errors[field.key] || undefined">
      {{ field.label || field.key }}
      <UToggle v-if="field.type === 'boolean'" size="sm" :model-value="value(field) === true" :aria-label="field.label || field.key" @update:model-value="update(field.key, $event)" />
      <USelect v-else-if="field.type === 'select'" :model-value="selectedOption(field)" :options="selectOptions(field)" size="xs" class="w-28" placeholder="Select" @update:model-value="updateOption(field, $event)" />
      <UInput v-else :model-value="String(value(field) ?? '')" :type="inputType(field)" size="xs" :class="field.type === 'number' ? 'w-16' : 'w-32'" :ui="field.type === 'number' ? { base: 'text-right tabular-nums' } : undefined" :step="field.type === 'number' ? 'any' : undefined" :autocomplete="field.type === 'secret' ? 'new-password' : undefined" @update:model-value="updateInput(field, $event)" />
    </label>
  </div>
  <div v-else class="space-y-4">
    <UFormGroup v-for="field in fields" :key="field.key" :label="field.label || field.key" :required="field.required" :error="errors[field.key]" :help="field.type === 'secret' && editing ? 'Leave empty to keep the current secret.' : undefined">
      <UToggle v-if="field.type === 'boolean'" :model-value="value(field) === true" :aria-label="field.label || field.key" @update:model-value="update(field.key, $event)" />
      <USelect v-else-if="field.type === 'select'" :model-value="selectedOption(field)" :options="selectOptions(field)" placeholder="Select an option" @update:model-value="updateOption(field, $event)" />
      <UInput v-else :model-value="String(value(field) ?? '')" :type="inputType(field)" :step="field.type === 'number' ? 'any' : undefined" :autocomplete="field.type === 'secret' ? 'new-password' : undefined" @update:model-value="updateInput(field, $event)" />
    </UFormGroup>
  </div>
</template>

<script setup lang="ts">
import type { PluginField } from '~/shared/types/plugin'

const props = defineProps<{ fields: PluginField[]; modelValue: Record<string, unknown>; editing?: boolean; compact?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>()
const errors = ref<Record<string, string>>({})

function inputType(field: PluginField): 'password' | 'number' | 'text' {
  if (field.type === 'secret') return 'password'
  if (field.type === 'number') return 'number'
  return 'text'
}

function value(field: PluginField): unknown {
  const current = props.modelValue[field.key]
  if (field.type === 'secret') return current ?? ''
  return current ?? field.default ?? (field.type === 'boolean' ? false : undefined)
}

// DOM option values are strings; indices preserve distinct values like 0, '0', and false.
function selectOptions(field: PluginField) {
  return (field.options || []).map((option, index) => ({ label: option.label, value: String(index) }))
}

function selectedOption(field: PluginField): string {
  const index = field.options?.findIndex(option => option.value === value(field)) ?? -1
  return index < 0 ? '' : String(index)
}

function updateOption(field: PluginField, selected: string | number) {
  const option = selected === '' ? undefined : field.options?.[Number(selected)]
  update(field.key, option?.value)
}

function updateInput(field: PluginField, input: string | number) {
  const text = String(input)
  update(field.key, field.type === 'number' && text.trim() ? Number(text) : text)
}

function update(key: string, value: unknown) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
  delete errors.value[key]
}

function validate(): boolean {
  errors.value = {}
  const values = { ...props.modelValue }
  for (const field of props.fields) {
    const current = value(field)
    const empty = current === undefined || current === null || (typeof current === 'string' && !current.trim())
    if (field.required && empty && !(field.type === 'secret' && props.editing)) errors.value[field.key] = 'This field is required'
    if (!empty && field.type === 'number' && (typeof current !== 'number' || !Number.isFinite(current))) errors.value[field.key] = 'Enter a valid number'
    if (!empty && field.type === 'boolean' && typeof current !== 'boolean') errors.value[field.key] = 'Choose a valid boolean value'
    if (!empty && field.type === 'select' && !field.options?.some(option => option.value === current)) errors.value[field.key] = 'Select a valid option'
    // Omit unchanged secrets so masked/blank reads never overwrite stored credentials.
    if (field.type === 'secret' && props.editing && empty) delete values[field.key]
    else if (current !== undefined) values[field.key] = current
  }
  emit('update:modelValue', values)
  return Object.keys(errors.value).length === 0
}

defineExpose({ validate })
</script>
