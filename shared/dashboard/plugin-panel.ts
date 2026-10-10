export const PANEL_CHANNEL = 'llmhub:panel:v1'
export const PANEL_MIN_HEIGHT = 120
export const PANEL_MAX_HEIGHT = 1200
export const PANEL_MAX_BODY_BYTES = 64 * 1024

export interface RuntimePanel {
  id: string
  title: string
  location: 'home' | 'detail' | 'page'
  page: string
}

type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue }
export type PanelRequest =
  | { type: 'ready' }
  | { type: 'height'; height: number }
  | { type: 'fetch'; requestId: string; path: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: JSONValue }

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function json(value: unknown, ancestors = new Set<object>(), depth = 0): value is JSONValue {
  if (depth > 20) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!Array.isArray(value) && !record(value)) return false
  if (ancestors.has(value)) return false
  ancestors.add(value)
  const valid = Object.values(value).every(item => json(item, ancestors, depth + 1))
  ancestors.delete(value)
  return valid
}

/** Never normalize attacker paths: reject ambiguous encodings before constructing a URL. */
export function panelAPIPath(pluginId: string, path: unknown): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(pluginId) || typeof path !== 'string' || path.length > 2048) return null
  const prefix = `/api/hub/plugins/${pluginId}/api/`
  const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path
  if (!relative || relative.startsWith('/') || /[\\%#\s\u0000-\u001f\u007f]/u.test(relative)) return null
  const [pathname, ...query] = relative.split('?')
  if (query.length > 1 || !pathname || pathname.split('/').some(segment => !/^[a-zA-Z0-9_-]+$/.test(segment))) return null
  if (query.length && !/^[a-zA-Z0-9_=&.,~+-]*$/.test(query[0]!)) return null
  return prefix + relative
}

/** Opaque origins all say "null"; exact Window identity is the authorization boundary. */
export function validatePanelMessage(event: { source: unknown; origin: string; data: unknown }, frameWindow: unknown, pluginId: string): PanelRequest | null {
  if (!frameWindow || event.source !== frameWindow || event.origin !== 'null' || !record(event.data)) return null
  const message = event.data
  if (message.channel !== PANEL_CHANNEL) return null
  const keys = Object.keys(message)
  if (message.type === 'ready') return keys.every(key => ['channel', 'type'].includes(key)) ? { type: 'ready' } : null
  if (message.type === 'height') {
    if (!keys.every(key => ['channel', 'type', 'height'].includes(key))) return null
    const height = message.height
    return typeof height === 'number' && Number.isInteger(height) && height >= PANEL_MIN_HEIGHT && height <= PANEL_MAX_HEIGHT ? { type: 'height', height } : null
  }
  if (message.type !== 'fetch' || !keys.every(key => ['channel', 'type', 'requestId', 'path', 'method', 'body'].includes(key))) return null
  if (typeof message.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(message.requestId)) return null
  const path = panelAPIPath(pluginId, message.path)
  const method = message.method
  if (!path || typeof method !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null
  if ('body' in message) {
    if (method === 'GET' || !json(message.body)) return null
    if (new TextEncoder().encode(JSON.stringify(message.body)).byteLength > PANEL_MAX_BODY_BYTES) return null
  }
  return { type: 'fetch', requestId: message.requestId, path, method: method as Extract<PanelRequest, { type: 'fetch' }>['method'], ...('body' in message ? { body: message.body as JSONValue } : {}) }
}
