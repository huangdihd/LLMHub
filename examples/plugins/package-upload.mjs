/**
 * A package-shaped literal manifest for the single-file upload workflow.
 * @type {import('./llmhub-plugin.js').PluginPackageManifest}
 */
export const manifest = {
  name: '@llmhub/example-package-upload',
  version: '1.0.0',
  description: 'Package metadata without a separate package.json.',
  engines: { llmhub: '^1.0.0' },
  llmhub: { id: 'example-package-upload', name: 'Package Upload' }
}

export default {
  /** @param {import('./llmhub-plugin.js').PluginAPI} api */
  setup(api) {
    api.registerRoute('GET', 'status', () => ({ ready: true }))
  }
}
