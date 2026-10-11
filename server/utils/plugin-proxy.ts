import { createError, getRequestURL, getRequestWebStream, sendStream, setResponseHeader, setResponseStatus, type H3Event } from 'h3'
import type { Hooks, Peer } from 'crossws'
import { getAuthStore } from '../stores/auth.store'
import { getPluginManager, PluginError } from '../plugins-runtime'

/**
 * Plugin proxies forward `/api/hub/plugins/<id>/proxy/<proxyId>/<rest>` to the base URL a plugin
 * names, over HTTP and WebSocket, for administrators only. The proxied application shares the
 * dashboard's origin, so it is trusted exactly as far as the plugin itself is.
 */
export const SESSION_COOKIE = 'llmhub_session'
const PROXY_PATH = /^\/api\/hub\/plugins\/([a-z0-9][a-z0-9-]*)\/proxy\/([a-z0-9][a-z0-9-]*)(\/[^?#]*)?$/
// Never forwarded in either direction: they describe this hop, not the proxied exchange.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'])
// fetch() decodes the body, so its original encoding and length no longer apply.
const DECODED = new Set(['content-encoding', 'content-length'])

export function parseProxyPath(pathname: string): { pluginId: string; proxyId: string; rest: string } | null {
  const match = PROXY_PATH.exec(pathname)
  return match ? { pluginId: match[1]!, proxyId: match[2]!, rest: match[3] || '/' } : null
}

/** Appends the request's remaining path and query to the plugin's base URL. */
export function proxyTarget(base: URL, rest: string, search: string): URL {
  const url = new URL(base)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${rest}`
  url.search = search
  return url
}

/** The dashboard session is the gateway's credential, never the proxied application's. */
export function withoutSession(cookie: string | undefined): string {
  return (cookie || '').split(';').map(part => part.trim()).filter(part => part && !part.startsWith(`${SESSION_COOKIE}=`)).join('; ')
}

export function forwardedHeaders(incoming: Record<string, string | string[] | undefined>, host: string, protocol: string): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP.has(name) || name.startsWith('sec-websocket-')) continue
    if (name === 'cookie') {
      const cookie = withoutSession(Array.isArray(value) ? value.join('; ') : value)
      if (cookie) headers.set('cookie', cookie)
      continue
    }
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  headers.set('x-forwarded-host', host)
  headers.set('x-forwarded-proto', protocol)
  return headers
}

async function resolve(pluginId: string, proxyId: string): Promise<URL> {
  let base: URL | null
  try { base = await getPluginManager().resolveProxy(pluginId, proxyId) }
  catch (error) {
    if (error instanceof PluginError) throw createError({ statusCode: /not found/i.test(error.message) ? 404 : 502, message: error.message })
    throw error
  }
  if (!base) throw createError({ statusCode: 503, message: 'The proxied service is not running' })
  return base
}

export async function proxyHttp(event: H3Event, pluginId: string, proxyId: string, rest: string): Promise<unknown> {
  const base = await resolve(pluginId, proxyId)
  const requestUrl = getRequestURL(event, { xForwardedHost: false, xForwardedProto: false })
  const target = proxyTarget(base, `/${rest}`.replace(/^\/+/, '/'), requestUrl.search)
  const method = event.method
  const aborted = new AbortController()
  event.node.res.once('close', () => aborted.abort())
  let response: Response
  try {
    response = await fetch(target, {
      method, redirect: 'manual', signal: aborted.signal,
      headers: forwardedHeaders(event.node.req.headers, requestUrl.host, requestUrl.protocol.replace(':', '')),
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: getRequestWebStream(event), duplex: 'half' })
    } as RequestInit)
  } catch {
    throw createError({ statusCode: 502, message: 'The proxied service did not answer' })
  }
  setResponseStatus(event, response.status, response.statusText)
  response.headers.forEach((value, name) => {
    if (HOP_BY_HOP.has(name) || DECODED.has(name) || name === 'set-cookie') return
    setResponseHeader(event, name, value)
  })
  const cookies = response.headers.getSetCookie().filter(cookie => !cookie.trim().startsWith(`${SESSION_COOKIE}=`))
  if (cookies.length) setResponseHeader(event, 'set-cookie', cookies)
  if (!response.body || method === 'HEAD') return null
  return sendStream(event, response.body)
}

async function authorized(headers: Headers): Promise<boolean> {
  const store = getAuthStore()
  if (!(await store.isSetup())) return false
  const token = /(?:^|;\s*)llmhub_session=([^;]+)/.exec(headers.get('cookie') || '')?.[1]
  return Boolean(token && await store.validateSession(decodeURIComponent(token)))
}

/** Browsers send cookies with cross-site WebSocket handshakes; only the dashboard's own pages may connect. */
export function sameOrigin(headers: Headers): boolean {
  const origin = headers.get('origin')
  const host = headers.get('host')
  if (!origin || !host) return false
  try { return new URL(origin).host === host } catch { return false }
}

interface Relay { upstream: WebSocket; queue: Array<string | Uint8Array>; raw: boolean }
const relays = new WeakMap<Peer, Relay>()

/** Relays each message between the browser and the plugin's service, keeping text and binary frames apart. */
export const proxyWebSocket: Partial<Hooks> = {
  async upgrade(request) {
    const url = new URL(request.url)
    const route = parseProxyPath(url.pathname)
    if (!route) return new Response('Not found', { status: 404 })
    if (!sameOrigin(request.headers)) return new Response('Forbidden', { status: 403 })
    if (!(await authorized(request.headers))) return new Response('Unauthorized', { status: 401 })
    let base: URL
    try { base = await resolve(route.pluginId, route.proxyId) }
    catch (error) { return new Response('Unavailable', { status: (error as { statusCode?: number }).statusCode || 502 }) }
    const target = proxyTarget(base, route.rest, url.search)
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
    const incoming: Record<string, string> = {}
    request.headers.forEach((value, name) => { incoming[name] = value })
    // The service sees itself as the origin, the way a browser connecting to it directly would present.
    const headers = forwardedHeaders(incoming, url.host, url.protocol === 'wss:' || url.protocol === 'https:' ? 'https' : 'http')
    headers.set('origin', `${base.protocol}//${base.host}`)
    ;(request as { context?: Record<string, unknown> }).context!.proxy = { target: target.href, headers: Object.fromEntries(headers), protocols: request.headers.get('sec-websocket-protocol') }
  },
  open(peer) {
    const { target, headers, protocols } = (peer.context as { proxy: { target: string; headers: Record<string, string>; protocols: string | null } }).proxy
    const upstream = new WebSocket(target, { headers, protocols: protocols ? protocols.split(',').map(value => value.trim()) : [] } as unknown as string[])
    upstream.binaryType = 'arraybuffer'
    const relay: Relay = { upstream, queue: [], raw: false }
    relays.set(peer, relay)
    upstream.onopen = () => { for (const message of relay.queue.splice(0)) upstream.send(message) }
    upstream.onmessage = message => peer.send(typeof message.data === 'string' ? message.data : new Uint8Array(message.data as ArrayBuffer))
    upstream.onclose = event => peer.close(event.code === 1005 || event.code === 1006 ? 1000 : event.code, event.reason)
    upstream.onerror = () => peer.close(1011, 'Proxied service unavailable')
    // The Node adapter exposes the underlying socket, which still knows whether a frame was text.
    const socket = peer.websocket as unknown as { on?: (name: string, listener: (data: Buffer, binary: boolean) => void) => void }
    if (typeof socket.on === 'function') {
      relay.raw = true
      socket.on('message', (data, binary) => forward(relay, binary ? new Uint8Array(data) : data.toString('utf8')))
    }
  },
  message(peer, message) {
    const relay = relays.get(peer)
    if (relay && !relay.raw) forward(relay, message.uint8Array())
  },
  close(peer) {
    const relay = relays.get(peer)
    relays.delete(peer)
    if (relay && relay.upstream.readyState <= WebSocket.OPEN) relay.upstream.close()
  },
  error(peer) {
    relays.get(peer)?.upstream.close()
  }
}

function forward(relay: Relay, data: string | Uint8Array) {
  if (relay.upstream.readyState === WebSocket.CONNECTING) relay.queue.push(data)
  else if (relay.upstream.readyState === WebSocket.OPEN) relay.upstream.send(data)
}
