import { setCookie, getHeader } from 'h3'
import { getAuthStore } from '../../stores/auth.store'
import type { BruteForceConfig } from '../../stores/auth.store'

function getClientIP(event: any, cfg: BruteForceConfig): string {
  if (cfg.ip_header) {
    const val = getHeader(event, cfg.ip_header)
    if (val) return val.split(',')[0].trim()
  }
  return event.node.req.socket?.remoteAddress || '127.0.0.1'
}

export default defineEventHandler(async (event) => {
  const store = getAuthStore()

  if (!(await store.isSetup())) {
    throw createError({ statusCode: 400, message: 'Not set up.' })
  }

  const cfg = await store.getBruteForceConfig()
  const ip = getClientIP(event, cfg)

  // Brute-force check
  if (cfg.enabled) {
    const entry = await store.getBruteForceEntry(ip)
    if (entry?.locked_until && Date.now() < entry.locked_until) {
      const remain = Math.ceil((entry.locked_until - Date.now()) / 1000 / 60)
      throw createError({
        statusCode: 429,
        statusMessage: 'Too Many Requests',
        data: { error: { message: `Too many attempts. Try again in ${remain} minute(s).` } }
      })
    }
  }

  const { password } = await readBody(event)
  if (!password) {
    throw createError({ statusCode: 400, message: 'Password required.' })
  }

  const valid = await store.verifyPassword(password)
  if (!valid) {
    if (cfg.enabled) {
      await store.recordFailedAttempt(ip, cfg)
    }
    throw createError({ statusCode: 401, message: 'Invalid password.' })
  }

  // Success — clear brute force
  if (cfg.enabled) {
    await store.clearBruteForce(ip)
  }

  const token = await store.createSession()
  setCookie(event, 'llmhub_session', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NUXT_COOKIE_SECURE !== 'false',
    path: '/',
    maxAge: 24 * 60 * 60
  })

  return { success: true }
})
