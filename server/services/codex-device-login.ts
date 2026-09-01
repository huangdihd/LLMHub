import { createHash, randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import { getCookie } from 'h3'
import type { ModelConfig, ProviderConfig } from '../core/types'
import { ProviderLoader } from '../providers/loader'
import { getProviderStore } from '../stores/provider.store'
import {
  CODEX_BACKEND_BASE_URL,
  exchangeCodexAuthorizationCode,
  extractChatGptAccountId,
  extractJwtExpiry,
  pollCodexDeviceCode,
  requestCodexDeviceCode
} from '../utils/codex-auth'

const SESSION_TTL_MS = 15 * 60 * 1000
const FINISHED_TTL_MS = 60 * 1000
const START_WINDOW_MS = 10 * 60 * 1000
const MAX_STARTS_PER_WINDOW = 3
const MAX_ACTIVE_SESSIONS = 20

type LoginStatus = 'pending' | 'completed' | 'failed' | 'cancelled'

interface ProviderDraft {
  name: string
  display_name: string
  enabled: boolean
  normalize_cch: boolean
  timeout: number
  enable_timeout: boolean
  max_retries: number
  use_custom_models: boolean
  models: ModelConfig[]
  reconnect: boolean
}

interface LoginSession {
  id: string
  actor: string
  deviceAuthId: string
  userCode: string
  verificationUrl: string
  intervalMs: number
  nextPollAt: number
  expiresAt: number
  status: LoginStatus
  draft: ProviderDraft
  error?: string
  provider?: any
  inFlight?: Promise<void>
  finishedAt?: number
}

const sessions = new Map<string, LoginSession>()
const activeByActor = new Map<string, string>()
const startsByActor = new Map<string, number[]>()
const startingActors = new Set<string>()

export function codexLoginActor(event: H3Event): string {
  const session = getCookie(event, 'llmhub_session') || ''
  if (session) return createHash('sha256').update(session).digest('hex')
  return createHash('sha256').update(event.node.req.socket.remoteAddress || 'local').digest('hex')
}

export async function startCodexDeviceLogin(actor: string, draft: ProviderDraft) {
  cleanupSessions()
  assertStartAllowed(actor)

  const currentId = activeByActor.get(actor)
  if (currentId) {
    const current = sessions.get(currentId)
    if (current?.status === 'pending' && current.expiresAt > Date.now()) {
      throw createError({ statusCode: 409, message: 'A ChatGPT login is already waiting for this session' })
    }
  }
  if (startingActors.has(actor)) {
    throw createError({ statusCode: 409, message: 'A ChatGPT login is already starting for this session' })
  }
  if (pendingSessionCount() + startingActors.size >= MAX_ACTIVE_SESSIONS) {
    throw createError({ statusCode: 429, message: 'Too many ChatGPT logins are already waiting' })
  }

  const store = getProviderStore()
  const existing = await store.get(draft.name)
  if (draft.reconnect) {
    if (!existing || existing.protocol !== 'codex-subscription') {
      throw createError({ statusCode: 404, message: 'Codex Subscription provider not found' })
    }
  } else if (existing) {
    throw createError({ statusCode: 409, message: `Provider '${draft.name}' already exists` })
  }

  recordStart(actor, Date.now())
  startingActors.add(actor)
  let device
  try {
    device = await requestCodexDeviceCode()
  } finally {
    startingActors.delete(actor)
  }
  const id = randomUUID()
  const now = Date.now()
  const session: LoginSession = {
    id,
    actor,
    deviceAuthId: device.device_auth_id,
    userCode: device.user_code,
    verificationUrl: device.verification_url,
    intervalMs: Math.max(device.interval * 1000, 1000),
    nextPollAt: now,
    expiresAt: now + SESSION_TTL_MS,
    status: 'pending',
    draft
  }
  sessions.set(id, session)
  activeByActor.set(actor, id)
  return publicSession(session)
}

export async function pollCodexDeviceLogin(actor: string, id: string) {
  cleanupSessions()
  const session = requireSession(actor, id)
  if (session.status !== 'pending') return publicSession(session)

  if (Date.now() >= session.expiresAt) {
    failSession(session, 'This login code expired. Start a new login.')
    return publicSession(session)
  }
  if (session.inFlight) {
    await session.inFlight
    return publicSession(session)
  }
  if (Date.now() < session.nextPollAt) return publicSession(session)

  session.nextPollAt = Date.now() + session.intervalMs
  session.inFlight = completeLogin(session).finally(() => { session.inFlight = undefined })
  await session.inFlight
  return publicSession(session)
}

export function cancelCodexDeviceLogin(actor: string, id: string) {
  const session = requireSession(actor, id)
  if (session.status === 'pending') {
    session.status = 'cancelled'
    session.finishedAt = Date.now()
    activeByActor.delete(actor)
  }
  return { status: session.status }
}

async function completeLogin(session: LoginSession): Promise<void> {
  try {
    const polled = await pollCodexDeviceCode(session.deviceAuthId, session.userCode)
    if (polled.pending) return

    const tokens = await exchangeCodexAuthorizationCode(
      polled.authorization_code,
      polled.code_verifier
    )
    const store = getProviderStore()
    const existing = await store.get(session.draft.name)
    const accountId = extractChatGptAccountId(tokens.id_token)
      || extractChatGptAccountId(tokens.access_token)
    const connection: ProviderConfig['connection'] = {
      api_key: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
      account_id: accountId,
      device_id: existing?.connection.device_id || randomUUID(),
      token_expires_at: extractJwtExpiry(tokens.access_token),
      base_url: existing?.connection.base_url || CODEX_BACKEND_BASE_URL,
      timeout: session.draft.timeout,
      enable_timeout: session.draft.enable_timeout,
      max_retries: session.draft.max_retries
    }

    let saved: ProviderConfig | null
    if (session.draft.reconnect) {
      saved = await store.update(session.draft.name, { connection })
    } else {
      saved = await store.create({
        name: session.draft.name,
        display_name: session.draft.display_name || 'Codex Subscription',
        protocol: 'codex-subscription',
        enabled: session.draft.enabled,
        normalize_cch: session.draft.normalize_cch,
        use_custom_models: session.draft.use_custom_models,
        models: session.draft.models,
        connection
      })
    }
    if (!saved) throw new Error('Provider disappeared while login was completing')

    ProviderLoader.invalidateCache()
    session.status = 'completed'
    session.provider = store.sanitize(saved)
    session.finishedAt = Date.now()
    activeByActor.delete(session.actor)
  } catch (error: any) {
    failSession(session, error?.message || 'Unable to finish ChatGPT login')
  }
}

function publicSession(session: LoginSession) {
  return {
    login_id: session.id,
    status: session.status,
    verification_url: session.verificationUrl,
    user_code: session.userCode,
    expires_at: session.expiresAt,
    ...(session.error ? { error: session.error } : {}),
    ...(session.provider ? { provider: session.provider } : {})
  }
}

function requireSession(actor: string, id: string): LoginSession {
  const session = sessions.get(id)
  if (!session || session.actor !== actor) {
    throw createError({ statusCode: 404, message: 'ChatGPT login session not found' })
  }
  return session
}

function failSession(session: LoginSession, message: string) {
  session.status = 'failed'
  session.error = message
  session.finishedAt = Date.now()
  activeByActor.delete(session.actor)
}

function assertStartAllowed(actor: string) {
  const cutoff = Date.now() - START_WINDOW_MS
  const recent = (startsByActor.get(actor) || []).filter(timestamp => timestamp > cutoff)
  startsByActor.set(actor, recent)
  if (recent.length >= MAX_STARTS_PER_WINDOW) {
    throw createError({ statusCode: 429, message: 'Too many login attempts. Try again in a few minutes.' })
  }
}

function recordStart(actor: string, now: number) {
  startsByActor.set(actor, [...(startsByActor.get(actor) || []), now])
}

function pendingSessionCount(): number {
  let count = 0
  for (const session of sessions.values()) {
    if (session.status === 'pending') count++
  }
  return count
}

function cleanupSessions() {
  const now = Date.now()
  for (const [id, session] of sessions) {
    const expiredPending = session.status === 'pending' && session.expiresAt <= now
    const expiredFinished = session.status !== 'pending'
      && (session.finishedAt || session.expiresAt) + FINISHED_TTL_MS <= now
    if (expiredPending) failSession(session, 'This login code expired. Start a new login.')
    if (expiredFinished) sessions.delete(id)
  }
  for (const [actor, timestamps] of startsByActor) {
    const recent = timestamps.filter(timestamp => timestamp > now - START_WINDOW_MS)
    if (recent.length) startsByActor.set(actor, recent)
    else startsByActor.delete(actor)
  }
}
