import type { PluginRecordLocation, PluginRecordValues } from '../../shared/types/plugin'
import type { PluginStorage } from './manager'

export const RECORD_VALUES_PREFIX = 'plugin-record-values:'
let pending: Promise<unknown> = Promise.resolve()

/** Shared with record deletion, so cleanup cannot race an in-flight dashboard write. */
export function withRecordValuesLock<T>(operation: () => Promise<T>): Promise<T> {
  const next = pending.then(operation, operation)
  pending = next.catch(() => {})
  return next
}

export function recordValuesKey(pluginId: string): string {
  return `${RECORD_VALUES_PREFIX}${pluginId}`
}

export type StoredRecordValues = Partial<Record<PluginRecordLocation, Record<string, PluginRecordValues>>>

/** Host-owned storage; never touches a plugin's private storage or gateway records. */
export function removeRecordContributions(storage: PluginStorage, location: PluginRecordLocation, recordId: string): Promise<void> {
  return withRecordValuesLock(async () => {
    for (const key of await storage.getKeys?.(RECORD_VALUES_PREFIX) ?? []) {
      const values = await storage.getItem<StoredRecordValues>(key)
      if (!values) continue
      let changed = false
      if (values[location] && Object.hasOwn(values[location]!, recordId)) {
        delete values[location]![recordId]
        changed = true
      }
      // Model IDs are provider-qualified; deleting the owner must not leave stale overrides.
      if (location === 'providers') {
        for (const modelId of Object.keys(values.models ?? {})) {
          if (!modelId.startsWith(`${recordId}/`)) continue
          delete values.models![modelId]
          changed = true
        }
      }
      if (changed) await storage.setItem(key, values)
    }
  })
}
