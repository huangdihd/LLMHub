import type { H3Event } from 'h3'
import type { AdmissionRejection } from './hooks'

export interface IngressModel {
  model: string
  replace(model: string): void
}

export interface IngressDefinition {
  id: string
  pathPrefix: string
  extractKey(event: H3Event): string
  missingKeyMessage: string
  extractModel(event: H3Event): IngressModel | Promise<IngressModel>
  rewriteBeforeRejection: boolean
  sendError(event: H3Event, rejection: AdmissionRejection): unknown | Promise<unknown>
}

/** First registration wins raw startsWith matching, including overlapping prefixes. */
export class IngressRegistry {
  private readonly definitions = new Map<string, IngressDefinition>()

  register(definition: IngressDefinition): () => void {
    if (typeof definition.id !== 'string' || !definition.id.trim()) throw new Error('Ingress ID must not be empty')
    if (typeof definition.pathPrefix !== 'string' || !definition.pathPrefix.startsWith('/')) throw new Error('Invalid ingress path prefix')
    if (typeof definition.extractKey !== 'function' || typeof definition.extractModel !== 'function'
      || typeof definition.sendError !== 'function' || typeof definition.missingKeyMessage !== 'string'
      || typeof definition.rewriteBeforeRejection !== 'boolean') throw new Error('Invalid ingress definition')
    if (this.definitions.has(definition.id)) throw new Error(`Ingress already registered: ${definition.id}`)
    if (this.list().some(registered => registered.pathPrefix === definition.pathPrefix)) throw new Error(`Ingress path prefix already registered: ${definition.pathPrefix}`)
    this.definitions.set(definition.id, definition)
    return () => { if (this.definitions.get(definition.id) === definition) this.definitions.delete(definition.id) }
  }

  get(id: string): IngressDefinition | undefined {
    return this.definitions.get(id)
  }

  list(): IngressDefinition[] {
    return Array.from(this.definitions.values())
  }

  match(path: string): IngressDefinition | undefined {
    return this.list().find(definition => path.startsWith(definition.pathPrefix))
  }
}

export const ingressRegistry = new IngressRegistry()
