import { Buffer } from 'node:buffer'

export const CODEX_AUTH_BASE_URL = 'https://auth.openai.com'
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_DEFAULT_CLIENT_VERSION = '0.149.0'
export const CODEX_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api/codex'

export interface CodexOAuthTokens {
  access_token: string
  refresh_token: string
  id_token: string
}

export interface CodexDeviceCode {
  device_auth_id: string
  user_code: string
  interval: number
  verification_url: string
}

/** Extract the ChatGPT workspace/account id when a Codex access token is a JWT. */
export function extractChatGptAccountId(token?: string): string | undefined {
  const decoded = decodeJwtPayload(token)
  return decoded?.['https://api.openai.com/auth']?.chatgpt_account_id
    || decoded?.chatgpt_account_id
    || decoded?.account_id
}

export function extractJwtExpiry(token?: string): number | undefined {
  const exp = decodeJwtPayload(token)?.exp
  return typeof exp === 'number' ? exp * 1000 : undefined
}

export async function requestCodexDeviceCode(fetcher: typeof fetch = fetch): Promise<CodexDeviceCode> {
  const response = await fetcher(`${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID })
  })
  if (!response.ok) throw await codexAuthError(response, 'Unable to start ChatGPT device login')

  const body = await response.json() as any
  const interval = Number.parseInt(String(body.interval || '5'), 10)
  if (!body.device_auth_id || !body.user_code) {
    throw new Error('OpenAI returned an invalid device login response')
  }
  return {
    device_auth_id: body.device_auth_id,
    user_code: body.user_code,
    interval: Number.isFinite(interval) ? Math.max(interval, 1) : 5,
    verification_url: `${CODEX_AUTH_BASE_URL}/codex/device`
  }
}

export async function pollCodexDeviceCode(
  deviceAuthId: string,
  userCode: string,
  fetcher: typeof fetch = fetch
): Promise<{ pending: true } | { pending: false; authorization_code: string; code_verifier: string }> {
  const response = await fetcher(`${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode })
  })
  if (response.status === 403 || response.status === 404) return { pending: true }
  if (!response.ok) throw await codexAuthError(response, 'ChatGPT device login failed')

  const body = await response.json() as any
  if (!body.authorization_code || !body.code_verifier) {
    throw new Error('OpenAI returned an invalid device authorization response')
  }
  return {
    pending: false,
    authorization_code: body.authorization_code,
    code_verifier: body.code_verifier
  }
}

export async function exchangeCodexAuthorizationCode(
  authorizationCode: string,
  codeVerifier: string,
  fetcher: typeof fetch = fetch
): Promise<CodexOAuthTokens> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: `${CODEX_AUTH_BASE_URL}/deviceauth/callback`,
    client_id: CODEX_CLIENT_ID,
    code_verifier: codeVerifier
  })
  const response = await fetcher(`${CODEX_AUTH_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  })
  if (!response.ok) throw await codexAuthError(response, 'Unable to finish ChatGPT login')
  return validateTokens(await response.json())
}

export async function refreshCodexTokens(
  refreshToken: string,
  fetcher: typeof fetch = fetch
): Promise<Partial<CodexOAuthTokens>> {
  const response = await fetcher(`${CODEX_AUTH_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  })
  if (!response.ok) throw await codexAuthError(response, 'ChatGPT session expired; reconnect this provider')
  const body = await response.json() as any
  if (!body.access_token) throw new Error('OpenAI returned an invalid token refresh response')
  return {
    access_token: body.access_token,
    ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
    ...(body.id_token ? { id_token: body.id_token } : {})
  }
}

function decodeJwtPayload(token?: string): any | undefined {
  if (!token) return undefined
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

function validateTokens(body: any): CodexOAuthTokens {
  if (!body?.access_token || !body?.refresh_token || !body?.id_token) {
    throw new Error('OpenAI returned an incomplete token response')
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    id_token: body.id_token
  }
}

async function codexAuthError(response: Response, fallback: string): Promise<Error> {
  const text = await response.text().catch(() => '')
  let message = fallback
  try {
    const body = JSON.parse(text)
    message = body.error_description || body.error?.message || body.message || fallback
  } catch {}
  const error: any = new Error(message)
  error.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502
  return error
}
