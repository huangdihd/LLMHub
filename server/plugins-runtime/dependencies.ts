/// <reference path="./semver.d.ts" />
import { valid, satisfies } from 'semver'
import type { PluginManifest, PluginRecord, PluginDependencyStatus } from '../../shared/types/plugin'
import { PLUGIN_API_VERSION } from '../core/plugin-version'
import { PluginError } from './manifest'

export function assertCompatibility(manifest: PluginManifest): void {
  const range = manifest.engines?.llmhub
  if (range && !satisfies(PLUGIN_API_VERSION, range)) {
    throw new PluginError(`Plugin ${manifest.id} requires plugin API ${range}; current version is ${PLUGIN_API_VERSION}`)
  }
}

export function manifestWarnings(manifest: PluginManifest): string[] {
  const warnings: string[] = []
  if (!manifest.engines?.llmhub) warnings.push('Plugin API compatibility is not declared (engines.llmhub)')
  if (!valid(manifest.version)) warnings.push(`Legacy plugin version is not valid semver: ${manifest.version}`)
  return warnings
}

function dependencyStatuses(manifest: PluginManifest, records: PluginRecord[]): PluginDependencyStatus[] {
  const required = manifest.dependencies ?? {}
  const optional = manifest.optionalDependencies ?? {}
  return Object.entries({ ...optional, ...required }).map(([id, range]) => {
    const dependency = records.find(record => record.id === id)
    let reason: string | undefined
    if (!dependency) reason = `${id}: not installed (requires ${range})`
    else if (!valid(dependency.manifest.version) || !satisfies(dependency.manifest.version, range)) {
      reason = `${id}: requires ${range}; installed version is ${dependency.manifest.version}`
    } else if (!dependency.enabled || dependency.status === 'error') {
      reason = `${id}: unavailable${dependency.error ? ` (${dependency.error})` : ' (not enabled)'}`
    }
    return { id, range, optional: !Object.hasOwn(required, id), satisfied: !reason, version: dependency?.manifest.version, reason }
  })
}

export function dependencyIssues(manifest: PluginManifest, records: PluginRecord[]): string[] {
  return dependencyStatuses(manifest, records).filter(status => !status.optional && !status.satisfied).map(status => status.reason!)
}

export function decorateRecords(records: PluginRecord[]): PluginRecord[] {
  return records.map(record => ({ ...record, warnings: manifestWarnings(record.manifest),
    dependencies: dependencyStatuses(record.manifest, records),
    requiredBy: records.filter(other => Object.hasOwn(other.manifest.dependencies ?? {}, record.id)).map(other => other.id) }))
}

/** Stable topological layers; strongly connected components isolate cycles from unrelated plugins. */
export function dependencyOrder(manifests: PluginManifest[]): { order: string[]; cycles: Map<string, string> } {
  const byId = new Map(manifests.map(manifest => [manifest.id, manifest]))
  const edges = (id: string) => Object.keys({ ...byId.get(id)?.optionalDependencies, ...byId.get(id)?.dependencies }).filter(key => byId.has(key))
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const active = new Set<string>()
  const cycles = new Map<string, string>()
  let nextIndex = 0
  const visit = (id: string) => {
    indices.set(id, nextIndex); low.set(id, nextIndex++)
    stack.push(id); active.add(id)
    for (const dependency of edges(id)) {
      if (!indices.has(dependency)) { visit(dependency); low.set(id, Math.min(low.get(id)!, low.get(dependency)!)) }
      else if (active.has(dependency)) low.set(id, Math.min(low.get(id)!, indices.get(dependency)!))
    }
    if (low.get(id) !== indices.get(id)) return
    const component: string[] = []
    let member: string
    do { member = stack.pop()!; active.delete(member); component.push(member) } while (member !== id)
    if (component.length > 1 || edges(id).includes(id)) {
      const reason = `Dependency cycle among: ${component.reverse().join(', ')}`
      for (const key of component) cycles.set(key, reason)
    }
  }
  for (const id of byId.keys()) if (!indices.has(id)) visit(id)
  const remaining = new Set([...byId.keys()].filter(id => !cycles.has(id)))
  const order: string[] = []
  while (remaining.size) {
    const layer = [...remaining].filter(id => edges(id).every(dependency => !remaining.has(dependency)))
    for (const id of layer) { remaining.delete(id); order.push(id) }
  }
  return { order, cycles }
}
