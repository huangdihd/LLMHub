import { randomBytes } from 'node:crypto'

export const GEMINI_CLI_CLIENT_ID = process.env.GEMINI_CLI_OAUTH_CLIENT_ID?.trim() || ''
export const GEMINI_CLI_CLIENT_SECRET = process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET?.trim() || ''
export const GEMINI_CLI_REDIRECT_URI = 'http://127.0.0.1:8085/oauth2callback'
export const GEMINI_CLI_API_BASE_URL = 'https://cloudcode-pa.googleapis.com'
export const GEMINI_CLI_USER_AGENT = 'GeminiCLI/0.1.5/gemini-2.5-pro (darwin; arm64)'

const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
]

export interface GeminiCliOAuthTokens {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type?: string
  scope?: string
}

export interface GeminiCliAccount {
  projectId: string
  email?: string
  tier?: string
  credits?: Array<{ creditType?: string; creditAmount?: string }>
}

export function createGeminiCliAuthorization() {
  assertGeminiCliOAuthConfigured()
  const state = randomBytes(24).toString('base64url')
  const url = new URL(AUTHORIZATION_URL)
  url.searchParams.set('client_id', GEMINI_CLI_CLIENT_ID)
  url.searchParams.set('redirect_uri', GEMINI_CLI_REDIRECT_URI)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPES.join(' '))
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent select_account')
  url.searchParams.set('state', state)
  return { authorization_url: url.toString(), state }
}

/** Extract a code from a copied loopback callback while enforcing its OAuth state. */
export function parseGeminiCliAuthorizationCode(value: string, expectedState: string): string {
  const input = value.trim()
  if (!input || !/^https?:\/\//i.test(input)) {
    throw new Error('Paste the complete Google callback URL, including its state parameter')
  }

  const url = new URL(input)
  const expected = new URL(GEMINI_CLI_REDIRECT_URI)
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new Error(`Google callback must start with ${GEMINI_CLI_REDIRECT_URI}`)
  }
  const authorizationError = url.searchParams.get('error')
  if (authorizationError) throw new Error(`Google authorization failed: ${authorizationError}`)
  if (url.searchParams.get('state') !== expectedState) {
    throw new Error('Google authorization state did not match')
  }
  const code = url.searchParams.get('code')
  if (!code) throw new Error('The callback URL does not contain an authorization code')
  return code
}

export async function exchangeGeminiCliAuthorizationCode(
  code: string,
  fetcher: typeof fetch = fetch
): Promise<GeminiCliOAuthTokens> {
  assertGeminiCliOAuthConfigured()
  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GEMINI_CLI_CLIENT_ID,
      client_secret: GEMINI_CLI_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: GEMINI_CLI_REDIRECT_URI
    }).toString()
  })
  if (!response.ok) throw await geminiCliAuthError(response, 'Unable to finish Google login')
  return validateTokens(await response.json(), true)
}

export async function refreshGeminiCliTokens(
  refreshToken: string,
  fetcher: typeof fetch = fetch
): Promise<GeminiCliOAuthTokens> {
  assertGeminiCliOAuthConfigured()
  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GEMINI_CLI_CLIENT_ID,
      client_secret: GEMINI_CLI_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString()
  })
  if (!response.ok) throw await geminiCliAuthError(response, 'Google session expired; reconnect this provider')
  return validateTokens(await response.json(), false)
}

export async function discoverGeminiCliAccount(
  accessToken: string,
  fetcher: typeof fetch = fetch
): Promise<GeminiCliAccount> {
  const metadata = {
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI'
  }
  const loaded = await geminiCliControlRequest('loadCodeAssist', { metadata }, accessToken, fetcher)
  const email = await fetchGoogleAccountEmail(accessToken, fetcher)
  const projectId = projectIdFrom(loaded.cloudaicompanionProject)
  const tier = loaded.paidTier || loaded.currentTier

  if (projectId) {
    return {
      projectId,
      email,
      ...(tier?.name ? { tier: tier.name } : {}),
      ...(Array.isArray(loaded.paidTier?.availableCredits)
        ? { credits: loaded.paidTier.availableCredits }
        : {})
    }
  }

  if (loaded.currentTier) {
    throw new Error('This Google account requires a Google Cloud project, which LLMHub does not configure automatically')
  }

  const defaultTier = Array.isArray(loaded.allowedTiers)
    ? loaded.allowedTiers.find((candidate: any) => candidate?.isDefault)
    : undefined
  if (!defaultTier?.id) {
    const reason = Array.isArray(loaded.ineligibleTiers)
      ? loaded.ineligibleTiers.map((candidate: any) => candidate?.reasonMessage).filter(Boolean).join(', ')
      : ''
    throw new Error(reason || 'This Google account is not eligible for Gemini Code Assist')
  }

  const operation = await geminiCliControlRequest('onboardUser', {
    tierId: defaultTier.id,
    metadata
  }, accessToken, fetcher)
  const completed = operation.done ? operation : await waitForOperation(operation.name, accessToken, fetcher)
  const onboardedProject = projectIdFrom(completed.response?.cloudaicompanionProject)
  if (!onboardedProject) throw new Error('Gemini CLI onboarding did not return a project')
  return {
    projectId: onboardedProject,
    email,
    ...(defaultTier.name ? { tier: defaultTier.name } : {})
  }
}

export async function fetchGeminiCliAccount(
  accessToken: string,
  projectId: string,
  fetcher: typeof fetch = fetch
): Promise<any> {
  return geminiCliControlRequest('loadCodeAssist', {
    cloudaicompanionProject: projectId,
    metadata: {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
      duetProject: projectId
    },
    mode: 'HEALTH_CHECK'
  }, accessToken, fetcher)
}

export async function geminiCliControlRequest(
  method: string,
  body: any,
  accessToken: string,
  fetcher: typeof fetch = fetch
): Promise<any> {
  const response = await fetcher(`${GEMINI_CLI_API_BASE_URL}/v1internal:${method}`, {
    method: 'POST',
    headers: geminiCliHeaders(accessToken),
    body: JSON.stringify(body)
  })
  if (!response.ok) throw await geminiCliAuthError(response, `Gemini CLI ${method} failed`)
  return response.json()
}

export function geminiCliHeaders(accessToken: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'User-Agent': GEMINI_CLI_USER_AGENT
  }
}

async function waitForOperation(name: unknown, accessToken: string, fetcher: typeof fetch): Promise<any> {
  if (typeof name !== 'string' || !name) throw new Error('Gemini CLI onboarding did not return an operation')
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    const response = await fetcher(`${GEMINI_CLI_API_BASE_URL}/v1internal/${name}`, {
      headers: geminiCliHeaders(accessToken)
    })
    if (!response.ok) throw await geminiCliAuthError(response, 'Unable to check Gemini CLI onboarding')
    const operation = await response.json()
    if (operation.done) return operation
  }
  throw new Error('Gemini CLI onboarding timed out')
}

async function fetchGoogleAccountEmail(accessToken: string, fetcher: typeof fetch): Promise<string | undefined> {
  try {
    const response = await fetcher(USERINFO_URL, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
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
  return value && typeof value.id === 'string' ? value.id || undefined : undefined
}

function assertGeminiCliOAuthConfigured(): void {
  if (GEMINI_CLI_CLIENT_ID && GEMINI_CLI_CLIENT_SECRET) return
  const error: any = new Error(
    'Gemini CLI OAuth is not configured. Set GEMINI_CLI_OAUTH_CLIENT_ID and GEMINI_CLI_OAUTH_CLIENT_SECRET.'
  )
  error.statusCode = 503
  throw error
}

function validateTokens(body: any, requireRefreshToken: boolean): GeminiCliOAuthTokens {
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

async function geminiCliAuthError(response: Response, fallback: string): Promise<Error> {
  const text = await response.text().catch(() => '')
  let message = fallback
  try {
    const body = JSON.parse(text)
    message = body.error_description || body.error?.message || body.error || body.message || fallback
  } catch {}
  const error: any = new Error(message)
  error.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502
  error._statusCode = response.status
  error._providerError = true
  return error
}
