import type { ProtocolParser, ProtocolSerializer } from './types'

export interface ProtocolDefinition {
  /** Registry identity; callers must use this ID, not parser.name, to select a serializer. */
  id: string
  createParser(): ProtocolParser
  createSerializer(): ProtocolSerializer
}

/** Registration order is parser precedence, matching the original manager. */
export class ProtocolRegistry {
  private definitions = new Map<string, ProtocolDefinition>()

  register(definition: ProtocolDefinition): () => void {
    if (typeof definition.id !== 'string' || !definition.id.trim()) throw new Error('Protocol ID must not be empty')
    if (this.definitions.has(definition.id)) throw new Error(`Protocol already registered: ${definition.id}`)
    this.definitions.set(definition.id, definition)
    return () => { if (this.definitions.get(definition.id) === definition) this.definitions.delete(definition.id) }
  }

  get(id: string): ProtocolDefinition | undefined {
    return this.definitions.get(id)
  }

  list(): ProtocolDefinition[] {
    return Array.from(this.definitions.values())
  }
}

export const protocolRegistry = new ProtocolRegistry()
