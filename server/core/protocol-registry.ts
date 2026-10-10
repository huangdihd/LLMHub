import type { ProtocolParser, ProtocolSerializer } from './types'

export interface ProtocolDefinition {
  id: string
  createParser(): ProtocolParser
  createSerializer(): ProtocolSerializer
}

/** Registration order is parser precedence, matching the original manager. */
export class ProtocolRegistry {
  private definitions = new Map<string, ProtocolDefinition>()

  register(definition: ProtocolDefinition): void {
    if (!definition.id.trim()) throw new Error('Protocol ID must not be empty')
    if (this.definitions.has(definition.id)) throw new Error(`Protocol already registered: ${definition.id}`)
    this.definitions.set(definition.id, definition)
  }

  get(id: string): ProtocolDefinition | undefined {
    return this.definitions.get(id)
  }

  list(): ProtocolDefinition[] {
    return Array.from(this.definitions.values())
  }
}
