import { Buffer } from 'node:buffer'

/** Extract the ChatGPT workspace/account id when a Codex access token is a JWT. */
export function extractChatGptAccountId(token?: string): string | undefined {
  if (!token) return undefined
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return decoded['https://api.openai.com/auth']?.chatgpt_account_id
      || decoded.chatgpt_account_id
      || decoded.account_id
  } catch {
    return undefined
  }
}
