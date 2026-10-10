/// <reference path="./semver.d.ts" />
import { valid, validRange } from 'semver'
import { lstat, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute, sep, parse } from 'node:path'
import type { PluginField, PluginManifest } from '../../shared/types/plugin'

/** Gateway-authored failure whose message is safe to show to dashboard administrators. */
export class PluginError extends Error {}

export { parseUploadedManifest } from './upload-manifest'

export function validateId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(value)) throw new PluginError('Invalid plugin identifier')
}

export function validatePath(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.includes('%') || isAbsolute(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw new PluginError('Invalid plugin path')
  return value
}

/** Reject symlinks at every component, not merely at the final file. */
export async function safePath(root: string, path = ''): Promise<string> {
  const base = resolve(root)
  const target = path ? resolve(base, validatePath(path)) : base
  const filesystemRoot = parse(target).root
  const absoluteParts = relative(filesystemRoot, target).split(sep).filter(Boolean)
  let current = filesystemRoot
  for (const part of absoluteParts) {
    current = resolve(current, part)
    const information = await lstat(current)
    if (information.isSymbolicLink()) throw new PluginError('Plugin symlinks are not allowed')
  }
  const actual = await realpath(target)
  const offset = relative(await realpath(base), actual)
  if (offset.startsWith('..') || isAbsolute(offset)) throw new PluginError('Invalid plugin path')
  return actual
}

export function validateFields(input: unknown): PluginField[] {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > 100) throw new PluginError('Invalid plugin schema')
  const seen = new Set<string>()
  for (const field of input) {
    if (!field || typeof field !== 'object' || typeof field.key !== 'string'
      || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(field.key) || ['__proto__', 'constructor', 'prototype'].includes(field.key)
      || seen.has(field.key) || !['text', 'secret', 'number', 'boolean', 'select'].includes(field.type)
      || (field.label !== undefined && typeof field.label !== 'string')
      || (field.required !== undefined && typeof field.required !== 'boolean')) throw new PluginError('Invalid plugin schema')
    seen.add(field.key)
    if (field.type === 'select' && (!Array.isArray(field.options) || !field.options.length
      || field.options.some((option: { label: unknown; value: unknown }) => !option || typeof option.label !== 'string'
        || !['string', 'number', 'boolean'].includes(typeof option.value)))) throw new PluginError('Invalid plugin options')
    if (field.type === 'secret' && field.default !== undefined) throw new PluginError('Secret defaults are not allowed')
    if (field.default !== undefined) validateConfiguration([{ ...field, required: false }], { [field.key]: field.default })
  }
  return structuredClone(input)
}

export function validateManifest(input: unknown, strictVersion = false): PluginManifest {
  if (!input || typeof input !== 'object') throw new PluginError('Invalid plugin manifest')
  const value = input as PluginManifest
  validateId(value.id)
  if (typeof value.name !== 'string' || !value.name.trim()) throw new PluginError('Plugin name is required')
  if (typeof value.version !== 'string' || !value.version || value.version.length > 100) throw new PluginError('Invalid plugin version')
  if (strictVersion && !valid(value.version)) throw new PluginError(`Invalid plugin semver version: ${value.version}`)
  if (value.engines !== undefined && (!value.engines || typeof value.engines !== 'object' || Array.isArray(value.engines))) throw new PluginError('Invalid plugin engines')
  if (value.engines?.llmhub !== undefined && (typeof value.engines.llmhub !== 'string' || !value.engines.llmhub.trim() || !validRange(value.engines.llmhub))) throw new PluginError('Invalid engines.llmhub semver range')
  for (const dependencies of [value.dependencies, value.optionalDependencies]) {
    if (dependencies === undefined) continue
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) throw new PluginError('Invalid plugin dependencies')
    for (const [id, range] of Object.entries(dependencies)) {
      validateId(id)
      if (typeof range !== 'string' || !range.trim() || !validRange(range)) throw new PluginError(`Invalid dependency range for ${id}`)
    }
  }
  for (const text of [value.name, value.description]) if (text !== undefined && (typeof text !== 'string' || text.length > 2000)) throw new PluginError('Invalid plugin manifest')
  if (value.entry !== undefined) validatePath(value.entry)
  if (value.ui !== undefined) validatePath(value.ui.page)
  return { id: value.id, name: value.name, version: value.version, description: value.description,
    engines: value.engines ? { llmhub: value.engines.llmhub } : undefined,
    dependencies: value.dependencies ? { ...value.dependencies } : undefined,
    optionalDependencies: value.optionalDependencies ? { ...value.optionalDependencies } : undefined,
    entry: value.entry, configSchema: validateFields(value.configSchema), ui: value.ui ? { page: value.ui.page } : undefined }
}

export function validateConfiguration(fields: PluginField[], input: unknown, previous: Record<string, unknown> = {}, requireFields = true): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PluginError('Invalid plugin configuration')
  const values = input as Record<string, unknown>
  if (Object.keys(values).some(key => !fields.some(field => field.key === key))) throw new PluginError('Unknown configuration field')
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    const previousValue = Object.hasOwn(previous, field.key) ? previous[field.key] : undefined
    let value = Object.hasOwn(values, field.key) ? values[field.key] : previousValue ?? field.default
    if (field.type === 'secret' && (value === '' || value === '********')) value = previousValue
    if (value === undefined || value === null || value === '') {
      if (field.required && requireFields) throw new PluginError('Required plugin configuration is missing')
      if (value !== undefined) result[field.key] = value
      continue
    }
    if ((['text', 'secret'].includes(field.type) && typeof value !== 'string')
      || (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))
      || (field.type === 'boolean' && typeof value !== 'boolean')
      || (field.type === 'select' && !field.options?.some(option => option.value === value))) throw new PluginError('Invalid configuration value')
    result[field.key] = value
  }
  return result
}
