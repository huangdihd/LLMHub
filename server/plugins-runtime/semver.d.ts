declare module 'semver' {
  export function valid(version: string): string | null
  export function validRange(range: string): string | null
  export function satisfies(version: string, range: string): boolean
  export function compare(version: string, other: string): number
  export function gt(version: string, other: string): boolean
}
