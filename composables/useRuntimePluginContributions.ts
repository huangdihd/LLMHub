import type { PluginContributionRecord, PluginMetricResult, PluginRecordLocation } from '~/shared/types/plugin'

export type RuntimeContributionLocation = PluginRecordLocation
export type RuntimePluginMetric = PluginMetricResult

export function runtimeContributionValuesURL(pluginId: string, location: RuntimeContributionLocation, recordId: string) {
  return `/api/hub/plugin-contributions/${encodeURIComponent(pluginId)}/${location}/${encodeURIComponent(recordId)}`
}

export function useRuntimePluginContributions() {
  const { data: plugins, error, refresh, pending } = useAsyncData('runtime-plugin-contributions',
    () => $fetch<PluginContributionRecord[]>('/api/hub/plugin-contributions'),
    { server: false, default: () => [] })
  const panels = computed(() => plugins.value.flatMap(plugin =>
    (plugin.contributes.panels || []).map(panel => ({ pluginId: plugin.id, panel }))))
  const navigation = computed(() => plugins.value.flatMap(plugin =>
    (plugin.contributes.navigation || []).filter(item =>
      plugin.contributes.panels?.some(panel => panel.id === item.panel && panel.location === 'page'))
      .map(item => ({ label: item.label, icon: item.icon,
        to: `/plugin-panels/${encodeURIComponent(plugin.id)}/${encodeURIComponent(item.panel)}` }))))
  return { plugins, panels, navigation, error, refresh, pending }
}
