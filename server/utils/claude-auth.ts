import { createHash, randomBytes } from 'node:crypto'

export const CLAUDE_AUTH_BASE_URL = 'https://claude.ai'
export const CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const CLAUDE_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'
export const CLAUDE_API_BASE_URL = 'https://api.anthropic.com'
export const CLAUDE_OAUTH_SCOPES = 'org:create_api_key user:profile user:inference'
export const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."
export const CLAUDE_CODE_BETA = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14'

export interface ClaudeOAuthTokens {
  access_token: string
  refresh_token: string
  expires_in: number
}

export interface ClaudeAuthorization {
  authorization_url: string
  code_verifier: string
  state: string
}

/** Build the same browser/PKCE authorization flow used by Claude Code. */
export function createClaudeAuthorization(): ClaudeAuthorization {
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const state = randomBytes(32).toString('base64url')
  const url = new URL(`${CLAUDE_AUTH_BASE_URL}/oauth/authorize`)
  url.search = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: CLAUDE_REDIRECT_URI,
    scope: CLAUDE_OAUTH_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state
  }).toString()
  return { authorization_url: url.toString(), code_verifier: codeVerifier, state }
}

/**
 * Claude's callback may display `code#state` as one copyable value. Split it
 * while preserving compatibility with pages that display only the code.
 */
export function parseClaudeAuthorizationCode(value: string, expectedState: string): { code: string; state: string } {
  const [code, returnedState, ...extra] = value.trim().split('#')
  if (!code || extra.length > 0) throw new Error('Enter the complete authorization code from Anthropic')
  if (returnedState && returnedState !== expectedState) throw new Error('Claude authorization state did not match')
  return { code, state: returnedState || expectedState }
}

export async function exchangeClaudeAuthorizationCode(
  code: string,
  codeVerifier: string,
  state: string,
  fetcher: typeof fetch = fetch
): Promise<ClaudeOAuthTokens> {
  const response = await fetcher(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      state,
      client_id: CLAUDE_CLIENT_ID,
      code_verifier: codeVerifier,
      redirect_uri: CLAUDE_REDIRECT_URI
    })
  })
  if (!response.ok) throw await claudeAuthError(response, 'Unable to finish Claude login')
  return validateTokens(await response.json())
}

export async function refreshClaudeTokens(
  refreshToken: string,
  fetcher: typeof fetch = fetch
): Promise<Partial<ClaudeOAuthTokens>> {
  const response = await fetcher(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_CLIENT_ID
    })
  })
  if (!response.ok) throw await claudeAuthError(response, 'Claude session expired; reconnect this provider')
  const body = await response.json() as any
  if (!body.access_token) throw new Error('Anthropic returned an invalid token refresh response')
  return {
    access_token: body.access_token,
    ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
    ...(Number(body.expires_in) > 0 ? { expires_in: Number(body.expires_in) } : {})
  }
}

function validateTokens(body: any): ClaudeOAuthTokens {
  if (!body?.access_token || !body?.refresh_token) {
    throw new Error('Anthropic returned an incomplete token response')
  }
  const expiresIn = Number(body.expires_in)
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_in: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600
  }
}

async function claudeAuthError(response: Response, fallback: string): Promise<Error> {
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
