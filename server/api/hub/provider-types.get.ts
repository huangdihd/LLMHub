import { providerRegistry } from '../../core/registry'

export default defineEventHandler(() => providerRegistry.list().map(definition => ({
  id: definition.id,
  displayName: definition.displayName ?? definition.id,
  // Respect explicitly declared secrets even when the plugin uses a text field.
  connectionSchema: (definition.connectionSchema ?? []).map(field => {
    if (!definition.secretConnectionFields.includes(`extra.${field.key}`)) return field
    const { default: _default, ...secretField } = field
    return { ...secretField, type: 'secret' as const }
  })
})))
