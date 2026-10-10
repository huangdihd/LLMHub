import { getPluginManager } from '../../../plugins-runtime'
import { PLUGIN_API_VERSION } from '../../../core/plugin-version'

// Keep the list response and all record fields backward-compatible.
export default defineEventHandler(() => getPluginManager().list().map(plugin => ({
  ...plugin,
  apiVersion: PLUGIN_API_VERSION
})))
