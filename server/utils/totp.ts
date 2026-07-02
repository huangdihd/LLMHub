import crypto from 'crypto'

// RFC 6238 TOTP (SHA-1, 6 digits, 30s period) — the variant used by
// Google Authenticator, 1Password, Authy, etc.

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

function hotp(key: Buffer, counter: number): string {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const hmac = crypto.createHmac('sha1', key).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3]
  return String(code % 1_000_000).padStart(6, '0')
}

export function generateTOTPSecret(): string {
  return base32Encode(crypto.randomBytes(20))
}

/** Verify a 6-digit code against the current time step only (window=0 by default). */
export function verifyTOTP(secret: string, code: string, window = 0): boolean {
  const clean = (code || '').replace(/\s+/g, '')
  if (!/^\d{6}$/.test(clean)) return false
  const key = base32Decode(secret)
  if (key.length === 0) return false
  const step = Math.floor(Date.now() / 1000 / 30)
  let valid = false
  for (let i = -window; i <= window; i++) {
    const expected = hotp(key, step + i)
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) valid = true
  }
  return valid
}

export function totpURI(secret: string, label = 'LLMHub Admin', issuer = 'LLMHub'): string {
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}
