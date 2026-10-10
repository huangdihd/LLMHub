<template>
  <div class="plugin-readme text-sm text-gray-700 dark:text-gray-300" v-html="html" />
</template>

<script setup lang="ts">
import { Marked } from 'marked'

const props = defineProps<{ source: string }>()

function escape(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function safeLink(href: string | null | undefined) {
  try {
    const url = new URL(href || '')
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
  } catch { return undefined }
}

// README text comes from the registry and is untrusted: raw HTML is shown as
// text, links are limited to http(s), and images are never fetched.
const markdown = new Marked({ gfm: true, breaks: false })
markdown.use({
  renderer: {
    html: token => escape(token.text),
    link(token) {
      const text = this.parser.parseInline(token.tokens)
      const href = safeLink(token.href)
      return href ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer nofollow">${text}</a>` : text
    },
    image: token => (token.text ? `<span class="plugin-readme-image">${escape(token.text)}</span>` : '')
  }
})

const html = computed(() => markdown.parse(props.source || '') as string)
</script>

<style>
.plugin-readme { line-height: 1.65; overflow-wrap: anywhere; }
.plugin-readme > :first-child { margin-top: 0; }
.plugin-readme h1, .plugin-readme h2, .plugin-readme h3, .plugin-readme h4 {
  font-weight: 600; margin: 1.4em 0 0.5em; color: rgb(17 24 39);
}
.dark .plugin-readme h1, .dark .plugin-readme h2, .dark .plugin-readme h3, .dark .plugin-readme h4 { color: rgb(255 255 255); }
.plugin-readme h1 { font-size: 1.25rem; }
.plugin-readme h2 { font-size: 1.1rem; }
.plugin-readme h3, .plugin-readme h4 { font-size: 1rem; }
.plugin-readme p, .plugin-readme ul, .plugin-readme ol, .plugin-readme pre, .plugin-readme table, .plugin-readme blockquote { margin: 0.75em 0; }
.plugin-readme ul { list-style: disc; padding-left: 1.4em; }
.plugin-readme ol { list-style: decimal; padding-left: 1.4em; }
.plugin-readme a { color: rgb(var(--color-primary-500)); text-decoration: underline; text-underline-offset: 2px; }
.plugin-readme code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85em;
  background: rgb(243 244 246); padding: 0.15em 0.35em; border-radius: 4px;
}
.dark .plugin-readme code { background: rgb(31 41 55); }
.plugin-readme pre { background: rgb(17 24 39); color: rgb(229 231 235); padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
.plugin-readme pre code, .dark .plugin-readme pre code { background: transparent; padding: 0; font-size: 0.8rem; }
.plugin-readme blockquote { border-left: 3px solid rgb(209 213 219); padding-left: 12px; color: rgb(107 114 128); }
.dark .plugin-readme blockquote { border-left-color: rgb(75 85 99); color: rgb(156 163 175); }
.plugin-readme table { border-collapse: collapse; display: block; overflow-x: auto; }
.plugin-readme th, .plugin-readme td { border: 1px solid rgb(229 231 235); padding: 6px 10px; text-align: left; }
.dark .plugin-readme th, .dark .plugin-readme td { border-color: rgb(55 65 81); }
.plugin-readme hr { border-color: rgb(229 231 235); margin: 1.5em 0; }
.dark .plugin-readme hr { border-color: rgb(55 65 81); }
.plugin-readme-image { color: rgb(156 163 175); font-style: italic; }
</style>
