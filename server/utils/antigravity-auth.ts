import { randomBytes } from 'node:crypto'

export const ANTIGRAVITY_CLIENT_ID = process.env.ANTIGRAVITY_OAUTH_CLIENT_ID?.trim() || ''
export const ANTIGRAVITY_CLIENT_SECRET = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() || ''
export const ANTIGRAVITY_REDIRECT_URI = 'http://localhost:8086'
export const ANTIGRAVITY_API_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com'
export const ANTIGRAVITY_PRODUCTION_API_BASE_URL = 'https://cloudcode-pa.googleapis.com'
export const ANTIGRAVITY_USER_AGENT = 'antigravity/2.8.1 darwin/arm64'

const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email'
]

export interface AntigravityOAuthTokens {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type?: string
  scope?: string
}

export function createAntigravityAuthorization() {
  assertAntigravityOAuthConfigured()
  const state = randomBytes(24).toString('base64url')
  const url = new URL(AUTHORIZATION_URL)
  url.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID)
  url.searchParams.set('redirect_uri', ANTIGRAVITY_REDIRECT_URI)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPES.join(' '))
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent select_account')
  url.searchParams.set('state', state)
  return { authorization_url: url.toString(), state }
}

/** Extract a code from the copied localhost callback while enforcing the OAuth state. */
export function parseAntigravityAuthorizationCode(value: string, expectedState: string): string {
  const input = value.trim()
  if (!input) throw new Error('Google callback URL is required')
  if (!/^https?:\/\//i.test(input)) {
    throw new Error('Paste the complete Google callback URL, including its state parameter')
  }

  const url = new URL(input)
  if (url.origin !== ANTIGRAVITY_REDIRECT_URI) {
    throw new Error(`Google callback must start with ${ANTIGRAVITY_REDIRECT_URI}`)
  }
  const error = url.searchParams.get('error')
  if (error) throw new Error(`Google authorization failed: ${error}`)
  const state = url.searchParams.get('state')
  if (!state || state !== expectedState) throw new Error('Google authorization state did not match')
  const code = url.searchParams.get('code')
  if (!code) throw new Error('The callback URL does not contain an authorization code')
  return code
}

export async function exchangeAntigravityAuthorizationCode(
  code: string,
  fetcher: typeof fetch = fetch
): Promise<AntigravityOAuthTokens> {
  assertAntigravityOAuthConfigured()
  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: ANTIGRAVITY_REDIRECT_URI
    }).toString()
  })
  if (!response.ok) throw await antigravityAuthError(response, 'Unable to finish Google login')
  return validateTokens(await response.json(), true)
}

export async function refreshAntigravityTokens(
  refreshToken: string,
  fetcher: typeof fetch = fetch
): Promise<AntigravityOAuthTokens> {
  assertAntigravityOAuthConfigured()
  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString()
  })
  if (!response.ok) throw await antigravityAuthError(response, 'Google session expired; reconnect this provider')
  return validateTokens(await response.json(), false)
}

export async function discoverAntigravityAccount(
  accessToken: string,
  fetcher: typeof fetch = fetch
): Promise<{ projectId: string; email?: string; tier?: string }> {
  const loaded = await antigravityControlRequest(
    ANTIGRAVITY_PRODUCTION_API_BASE_URL,
    'loadCodeAssist',
    { metadata: { ideType: 'ANTIGRAVITY' } },
    accessToken,
    fetcher
  )

  const existingProject = projectIdFrom(loaded.cloudaicompanionProject)
    || projectIdFrom(loaded.projectId)
    || projectIdFrom(loaded.project)
  const email = emailFromSubscriptionUri(loaded.manageSubscriptionUri)
    || await fetchGoogleAccountEmail(accessToken, fetcher)
  const defaultTier = Array.isArray(loaded.allowedTiers)
    ? loaded.allowedTiers.find((tier: any) => tier?.isDefault)?.id
    : undefined
  const tier = loaded.paidTier?.name || defaultTier
  if (existingProject) return { projectId: existingProject, email, tier }

  const request = {
    tier_id: defaultTier || 'free-tier',
    metadata: { ide_type: 'ANTIGRAVITY', ide_version: '2.8.1', ide_name: 'antigravity' }
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await antigravityControlRequest(
      ANTIGRAVITY_API_BASE_URL,
      'onboardUser',
      request,
      accessToken,
      fetcher
    )
    const projectId = projectIdFrom(result.response?.cloudaicompanionProject)
    if (result.done && projectId) return { projectId, email, tier }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error('Google Antigravity onboarding did not return a project')
}

export async function antigravityControlRequest(
  baseUrl: string,
  method: string,
  body: any,
  accessToken: string,
  fetcher: typeof fetch = fetch
): Promise<any> {
  const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/v1internal:${method}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'User-Agent': ANTIGRAVITY_USER_AGENT,
      ...(method === 'onboardUser' ? { 'X-Goog-Api-Client': 'gl-node/22.21.1' } : {})
    },
    body: JSON.stringify(body)
  })
  if (!response.ok) throw await antigravityAuthError(response, `Antigravity ${method} failed`)
  return response.json()
}

async function fetchGoogleAccountEmail(accessToken: string, fetcher: typeof fetch): Promise<string | undefined> {
  try {
    const response = await fetcher('https://www.googleapis.com/oauth2/v2/userinfo?alt=json', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': ANTIGRAVITY_USER_AGENT
      }
    })
    if (!response.ok) return undefined
    const body = await response.json()
    return typeof body?.email === 'string' ? body.email : undefined
  } catch {
    return undefined
  }
}

function projectIdFrom(value: any): string | undefined {
  if (typeof value === 'string') return value || undefined
  if (value && typeof value.id === 'string') return value.id || undefined
  return undefined
}

function emailFromSubscriptionUri(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return new URL(value).searchParams.get('Email') || undefined
  } catch {
    return value.match(/[?&]Email=([^&]+)/)?.[1]
      ? decodeURIComponent(value.match(/[?&]Email=([^&]+)/)![1])
      : undefined
  }
}

function assertAntigravityOAuthConfigured(): void {
  if (ANTIGRAVITY_CLIENT_ID && ANTIGRAVITY_CLIENT_SECRET) return
  const error: any = new Error(
    'Antigravity OAuth is not configured. Set ANTIGRAVITY_OAUTH_CLIENT_ID and ANTIGRAVITY_OAUTH_CLIENT_SECRET.'
  )
  error.statusCode = 503
  throw error
}

function validateTokens(body: any, requireRefreshToken: boolean): AntigravityOAuthTokens {
  if (!body?.access_token || (requireRefreshToken && !body?.refresh_token)) {
    throw new Error('Google returned an incomplete token response')
  }
  const expiresIn = Number(body.expires_in || 3600)
  return {
    access_token: body.access_token,
    ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
    expires_in: Number.isFinite(expiresIn) ? expiresIn : 3600,
    ...(body.token_type ? { token_type: body.token_type } : {}),
    ...(body.scope ? { scope: body.scope } : {})
  }
}

async function antigravityAuthError(response: Response, fallback: string): Promise<Error> {
  const text = await response.text().catch(() => '')
  let message = fallback
  try {
    const body = JSON.parse(text)
    message = body.error_description || body.error?.message || body.error || body.message || fallback
  } catch {}
  const error: any = new Error(message)
  error.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502
  return error
}
