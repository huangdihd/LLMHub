import { createHash, randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import { getCookie } from 'h3'
import type { ModelConfig, ProviderConfig } from '../core/types'
import { ProviderLoader } from '../providers/loader'
import { getProviderStore } from '../stores/provider.store'
import {
  CLAUDE_API_BASE_URL,
  createClaudeAuthorization,
  exchangeClaudeAuthorizationCode,
  parseClaudeAuthorizationCode
} from '../utils/claude-auth'

const SESSION_TTL_MS = 15 * 60 * 1000
const FINISHED_TTL_MS = 60 * 1000
const START_WINDOW_MS = 10 * 60 * 1000
const MAX_STARTS_PER_WINDOW = 3
const MAX_ACTIVE_SESSIONS = 20

export const DEFAULT_CLAUDE_SUBSCRIPTION_MODELS: ModelConfig[] = [
  { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', capabilities: { vision: true, tools: true, streaming: true } },
  { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', capabilities: { vision: true, tools: true, streaming: true } },
  { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', capabilities: { vision: true, tools: true, streaming: true } }
]

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
  authorizationUrl: string
  codeVerifier: string
  state: string
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

export function claudeLoginActor(event: H3Event): string {
  const session = getCookie(event, 'llmhub_session') || ''
  if (session) return createHash('sha256').update(session).digest('hex')
  return createHash('sha256').update(event.node.req.socket.remoteAddress || 'local').digest('hex')
}

export async function startClaudeLogin(actor: string, draft: ProviderDraft) {
  cleanupSessions()
  assertStartAllowed(actor)

  const currentId = activeByActor.get(actor)
  if (currentId) {
    const current = sessions.get(currentId)
    if (current?.status === 'pending' && current.expiresAt > Date.now()) {
      throw createError({ statusCode: 409, message: 'A Claude login is already waiting for this session' })
    }
  }
  if (startingActors.has(actor)) {
    throw createError({ statusCode: 409, message: 'A Claude login is already starting for this session' })
  }
  if (pendingSessionCount() + startingActors.size >= MAX_ACTIVE_SESSIONS) {
    throw createError({ statusCode: 429, message: 'Too many Claude logins are already waiting' })
  }

  const store = getProviderStore()
  const existing = await store.get(draft.name)
  if (draft.reconnect) {
    if (!existing || existing.protocol !== 'claude-subscription') {
      throw createError({ statusCode: 404, message: 'Claude Subscription provider not found' })
    }
  } else if (existing) {
    throw createError({ statusCode: 409, message: `Provider '${draft.name}' already exists` })
  }

  recordStart(actor, Date.now())
  startingActors.add(actor)
  let authorization
  try {
    authorization = createClaudeAuthorization()
  } finally {
    startingActors.delete(actor)
  }

  const id = randomUUID()
  const session: LoginSession = {
    id,
    actor,
    authorizationUrl: authorization.authorization_url,
    codeVerifier: authorization.code_verifier,
    state: authorization.state,
    expiresAt: Date.now() + SESSION_TTL_MS,
    status: 'pending',
    draft
  }
  sessions.set(id, session)
  activeByActor.set(actor, id)
  return publicSession(session)
}

export async function completeClaudeLogin(actor: string, id: string, authorizationCode: string) {
  cleanupSessions()
  const session = requireSession(actor, id)
  if (session.status !== 'pending') return publicSession(session)
  if (Date.now() >= session.expiresAt) {
    failSession(session, 'This Claude login expired. Start a new login.')
    return publicSession(session)
  }
  if (!authorizationCode.trim()) {
    throw createError({ statusCode: 400, message: 'Authorization code is required' })
  }
  if (session.inFlight) {
    await session.inFlight
    return publicSession(session)
  }

  session.inFlight = finishLogin(session, authorizationCode).finally(() => { session.inFlight = undefined })
  await session.inFlight
  return publicSession(session)
}

export function cancelClaudeLogin(actor: string, id: string) {
  const session = requireSession(actor, id)
  if (session.status === 'pending') {
    session.status = 'cancelled'
    session.finishedAt = Date.now()
    activeByActor.delete(actor)
  }
  return { status: session.status }
}

async function finishLogin(session: LoginSession, authorizationCode: string): Promise<void> {
  try {
    const parsed = parseClaudeAuthorizationCode(authorizationCode, session.state)
    const tokens = await exchangeClaudeAuthorizationCode(
      parsed.code,
      session.codeVerifier,
      parsed.state
    )
    const store = getProviderStore()
    const existing = await store.get(session.draft.name)
    const connection: ProviderConfig['connection'] = {
      api_key: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: Date.now() + tokens.expires_in * 1000,
      base_url: existing?.connection.base_url || CLAUDE_API_BASE_URL,
      version: existing?.connection.version || '2023-06-01',
      timeout: session.draft.timeout,
      enable_timeout: session.draft.enable_timeout,
      max_retries: session.draft.max_retries
    }
    const models = session.draft.models.length > 0
      ? session.draft.models
      : DEFAULT_CLAUDE_SUBSCRIPTION_MODELS

    let saved: ProviderConfig | null
    if (session.draft.reconnect) {
      saved = await store.update(session.draft.name, { connection })
    } else {
      saved = await store.create({
        name: session.draft.name,
        display_name: session.draft.display_name || 'Claude Subscription',
        protocol: 'claude-subscription',
        enabled: session.draft.enabled,
        normalize_cch: session.draft.normalize_cch,
        use_custom_models: session.draft.use_custom_models,
        models,
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
    failSession(session, error?.message || 'Unable to finish Claude login')
  }
}

function publicSession(session: LoginSession) {
  return {
    login_id: session.id,
    status: session.status,
    authorization_url: session.authorizationUrl,
    expires_at: session.expiresAt,
    ...(session.error ? { error: session.error } : {}),
    ...(session.provider ? { provider: session.provider } : {})
  }
}

function requireSession(actor: string, id: string): LoginSession {
  const session = sessions.get(id)
  if (!session || session.actor !== actor) {
    throw createError({ statusCode: 404, message: 'Claude login session not found' })
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
    if (expiredPending) failSession(session, 'This Claude login expired. Start a new login.')
    if (expiredFinished) sessions.delete(id)
  }
  for (const [actor, timestamps] of startsByActor) {
    const recent = timestamps.filter(timestamp => timestamp > now - START_WINDOW_MS)
    if (recent.length) startsByActor.set(actor, recent)
    else startsByActor.delete(actor)
  }
}
