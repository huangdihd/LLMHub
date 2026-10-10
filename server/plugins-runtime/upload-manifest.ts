import { PluginError, normalizeManifest } from './manifest'
import type { PluginManifest } from '../../shared/types/plugin'

/**
 * Read a literal manifest without executing any uploaded code or resolving imports.
 * Only comments and static ESM imports may precede `export const manifest`.
 * Both legacy and package-shaped literals are accepted. Computed manifests and
 * arbitrary preceding code require a separate package.json or plugin.json;
 * scanning general JavaScript without a full parser risks matching fake exports.
 */
export function parseUploadedManifest(source: string): PluginManifest {
  let position = 0
  const fail = (): never => { throw new PluginError('Upload requires a literal export const manifest = { ... }, preceded only by comments or static imports; use package.json or plugin.json for computed manifests') }
  const skip = () => {
    while (position < source.length) {
      if (/\s/.test(source[position]!)) { position++; continue }
      if (source.startsWith('//', position)) {
        position += 2
        while (position < source.length && !/[\n\r\u2028\u2029]/.test(source[position]!)) position++
        continue
      }
      if (source.startsWith('/*', position)) { const end = source.indexOf('*/', position + 2); if (end < 0) fail(); position = end + 2; continue }
      break
    }
  }
  const string = (): string => {
    const quote = source[position++]!
    let result = ''
    while (position < source.length) {
      const character = source[position++]!
      if (character === quote) return result
      if (character === '\n' || character === '\r') fail()
      if (character !== '\\') { result += character; continue }
      const escape = source[position++]!
      if (escape === undefined || /[1-9]/.test(escape) || (escape === '0' && /\d/.test(source[position] ?? ''))) fail()
      if (escape === '\n' || escape === '\r') {
        if (escape === '\r' && source[position] === '\n') position++
        continue
      }
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }
      if (escape === 'u' || escape === 'x') {
        const length = escape === 'u' ? 4 : 2
        const digits = source.slice(position, position + length)
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(digits)) fail()
        result += String.fromCharCode(parseInt(digits, 16)); position += length
      } else result += escapes[escape] ?? escape
    }
    return fail()
  }
  const identifier = (): string => {
    const match = /^[a-zA-Z_$][\w$]*/.exec(source.slice(position))
    if (!match) return fail()
    position += match[0].length
    return match[0]
  }
  const value = (depth = 0): unknown => {
    if (depth > 100) fail()
    skip()
    const character = source[position]
    if (character === '"' || character === "'") return string()
    if (character === '{' || character === '[') {
      position++
      const array = character === '['
      const result: Record<string, unknown> = Object.create(null)
      const items: unknown[] = []
      const closing = array ? ']' : '}'
      skip()
      while (source[position] !== closing) {
        if (array) items.push(value(depth + 1))
        else {
          skip()
          const key = source[position] === '"' || source[position] === "'" ? string() : identifier()
          if (Object.hasOwn(result, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail()
          skip(); if (source[position++] !== ':') fail()
          result[key] = value(depth + 1)
        }
        skip()
        if (source[position] === closing) break
        if (source[position++] !== ',') fail()
        skip()
      }
      position++
      return array ? items : result
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(position))
    if (number) {
      position += number[0].length
      const result = Number(number[0])
      if (!Number.isFinite(result)) fail()
      return result
    }
    const literal = identifier()
    if (literal === 'true') return true
    if (literal === 'false') return false
    if (literal === 'null') return null
    return fail()
  }
  const keyword = (expected: string) => {
    skip()
    if (identifier() !== expected) fail()
    skip()
  }
  const moduleSpecifier = () => {
    skip()
    if (source[position] !== '"' && source[position] !== "'") fail()
    string()
    const end = position
    skip()
    if (source[position] === ';') { position++; skip(); return }
    // Without a semicolon, the next statement must start on a new line (ASI).
    if (position !== source.length && !/[\n\r\u2028\u2029]/.test(source.slice(end, position))) fail()
  }
  const staticImport = () => {
    skip()
    if (source[position] === '"' || source[position] === "'") { moduleSpecifier(); return }
    if (source[position] !== '{' && source[position] !== '*') {
      identifier()
      skip()
      if (source[position] !== ',') { keyword('from'); moduleSpecifier(); return }
      position++
      skip()
    }
    if (source[position] === '*') {
      position++
      keyword('as')
      identifier()
    } else {
      if (source[position++] !== '{') fail()
      skip()
      while (source[position] !== '}') {
        const quoted = source[position] === '"' || source[position] === "'"
        if (quoted) string()
        else identifier()
        skip()
        if (quoted || /^[a-zA-Z_$]/.test(source[position] ?? '')) { keyword('as'); identifier(); skip() }
        if (source[position] === '}') break
        if (source[position++] !== ',') fail()
        skip()
      }
      position++
    }
    keyword('from')
    moduleSpecifier()
  }
  skip()
  let declaration = identifier()
  while (declaration === 'import') {
    staticImport()
    declaration = identifier()
  }
  if (declaration !== 'export') fail()
  skip(); if (identifier() !== 'const') fail()
  skip(); if (identifier() !== 'manifest') fail()
  skip(); if (source[position++] !== '=') fail()
  const manifest = value()
  skip(); if (source[position] !== ';' && !/^export\b/.test(source.slice(position)) && position !== source.length) fail()
  return normalizeManifest(manifest, true)
}
