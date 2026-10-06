import { createHash, randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import { getCookie } from 'h3'
import type { ModelConfig, ProviderConfig } from '../core/types'
import { ProviderLoader } from '../providers/loader'
import { DEFAULT_GEMINI_CLI_MODELS } from '../providers/gemini-cli'
import { getProviderStore } from '../stores/provider.store'
import {
  GEMINI_CLI_API_BASE_URL,
  createGeminiCliAuthorization,
  discoverGeminiCliAccount,
  exchangeGeminiCliAuthorizationCode,
  parseGeminiCliAuthorizationCode
} from '../utils/gemini-cli-auth'

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
  authorizationUrl: string
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

export function geminiCliLoginActor(event: H3Event): string {
  const session = getCookie(event, 'llmhub_session') || ''
  if (session) return createHash('sha256').update(session).digest('hex')
  return createHash('sha256').update(event.node.req.socket.remoteAddress || 'local').digest('hex')
}

export async function startGeminiCliLogin(actor: string, draft: ProviderDraft) {
  cleanupSessions()
  assertStartAllowed(actor)

  const current = activeByActor.get(actor)
  if (current && sessions.get(current)?.status === 'pending') {
    throw createError({ statusCode: 409, message: 'A Gemini CLI login is already waiting for this session' })
  }
  if (startingActors.has(actor)) {
    throw createError({ statusCode: 409, message: 'A Gemini CLI login is already starting for this session' })
  }
  if (pendingSessionCount() + startingActors.size >= MAX_ACTIVE_SESSIONS) {
    throw createError({ statusCode: 429, message: 'Too many Gemini CLI logins are already waiting' })
  }

  const existing = await getProviderStore().get(draft.name)
  if (draft.reconnect) {
    if (!existing || existing.protocol !== 'gemini-cli-subscription') {
      throw createError({ statusCode: 404, message: 'Gemini CLI Subscription provider not found' })
    }
  } else if (existing) {
    throw createError({ statusCode: 409, message: `Provider '${draft.name}' already exists` })
  }

  recordStart(actor, Date.now())
  startingActors.add(actor)
  let authorization
  try {
    authorization = createGeminiCliAuthorization()
  } finally {
    startingActors.delete(actor)
  }

  const id = randomUUID()
  const login: LoginSession = {
    id,
    actor,
    authorizationUrl: authorization.authorization_url,
    state: authorization.state,
    expiresAt: Date.now() + SESSION_TTL_MS,
    status: 'pending',
    draft
  }
  sessions.set(id, login)
  activeByActor.set(actor, id)
  return publicSession(login)
}

export async function completeGeminiCliLogin(actor: string, id: string, callbackUrl: string) {
  cleanupSessions()
  const session = requireSession(actor, id)
  if (session.status !== 'pending') return publicSession(session)
  if (Date.now() >= session.expiresAt) {
    failSession(session, 'This Gemini CLI login expired. Start a new login.')
    return publicSession(session)
  }
  if (!callbackUrl.trim()) throw createError({ statusCode: 400, message: 'Google callback URL is required' })
  if (session.inFlight) {
    await session.inFlight
    return publicSession(session)
  }

  session.inFlight = finishLogin(session, callbackUrl).finally(() => { session.inFlight = undefined })
  await session.inFlight
  return publicSession(session)
}

export function cancelGeminiCliLogin(actor: string, id: string) {
  const session = requireSession(actor, id)
  if (session.status === 'pending') {
    session.status = 'cancelled'
    session.finishedAt = Date.now()
    activeByActor.delete(actor)
  }
  return { status: session.status }
}

async function finishLogin(session: LoginSession, callbackUrl: string): Promise<void> {
  try {
    const code = parseGeminiCliAuthorizationCode(callbackUrl, session.state)
    const tokens = await exchangeGeminiCliAuthorizationCode(code)
    if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Revoke access and try connecting again.')
    const account = await discoverGeminiCliAccount(tokens.access_token)
    const store = getProviderStore()
    const existing = await store.get(session.draft.name)
    const connection: ProviderConfig['connection'] = {
      api_key: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: Date.now() + tokens.expires_in * 1000,
      project_id: account.projectId,
      ...(account.email ? { account_email: account.email } : {}),
      ...(account.tier ? { subscription_type: account.tier } : {}),
      base_url: existing?.connection.base_url || GEMINI_CLI_API_BASE_URL,
      timeout: session.draft.timeout,
      enable_timeout: session.draft.enable_timeout,
      max_retries: session.draft.max_retries
    }
    const models = session.draft.models.length > 0 ? session.draft.models : DEFAULT_GEMINI_CLI_MODELS

    const saved = session.draft.reconnect
      ? await store.update(session.draft.name, { connection })
      : await store.create({
          name: session.draft.name,
          display_name: session.draft.display_name || 'Gemini CLI Subscription',
          protocol: 'gemini-cli-subscription',
          enabled: session.draft.enabled,
          normalize_cch: session.draft.normalize_cch,
          use_custom_models: session.draft.use_custom_models,
          models,
          connection
        })
    if (!saved) throw new Error('Provider disappeared while login was completing')

    ProviderLoader.invalidateCache()
    session.status = 'completed'
    session.provider = store.sanitize(saved)
    session.finishedAt = Date.now()
    activeByActor.delete(session.actor)
  } catch (error: any) {
    failSession(session, error?.message || 'Unable to finish Gemini CLI login')
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
    throw createError({ statusCode: 404, message: 'Gemini CLI login session not found' })
  }
  return session
}

function failSession(session: LoginSession, message: string): void {
  session.status = 'failed'
  session.error = message
  session.finishedAt = Date.now()
  activeByActor.delete(session.actor)
}

function assertStartAllowed(actor: string): void {
  const recent = (startsByActor.get(actor) || []).filter(timestamp => timestamp > Date.now() - START_WINDOW_MS)
  startsByActor.set(actor, recent)
  if (recent.length >= MAX_STARTS_PER_WINDOW) {
    throw createError({ statusCode: 429, message: 'Too many login attempts. Try again in a few minutes.' })
  }
}

function recordStart(actor: string, now: number): void {
  startsByActor.set(actor, [...(startsByActor.get(actor) || []), now])
}

function pendingSessionCount(): number {
  return [...sessions.values()].filter(session => session.status === 'pending').length
}

function cleanupSessions(): void {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (session.status === 'pending' && session.expiresAt <= now) {
      failSession(session, 'This Gemini CLI login expired. Start a new login.')
    }
    if (session.status !== 'pending' && (session.finishedAt || session.expiresAt) + FINISHED_TTL_MS <= now) {
      sessions.delete(id)
    }
  }
  for (const [actor, timestamps] of startsByActor) {
    const recent = timestamps.filter(timestamp => timestamp > now - START_WINDOW_MS)
    if (recent.length) startsByActor.set(actor, recent)
    else startsByActor.delete(actor)
  }
}
