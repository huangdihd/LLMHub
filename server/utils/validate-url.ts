const BLOCKED_HOSTS = [
  '127.0.0.1',
  'localhost',
  '0.0.0.0',
  '[::1]',
  '127.0.0.0',
  '169.254.169.254'
]

function isPrivateIP(hostname: string): boolean {
  if (BLOCKED_HOSTS.includes(hostname)) return true

  // IPv4: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16
  const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (ipv4Match) {
    const b1 = parseInt(ipv4Match[1], 10)
    const b2 = parseInt(ipv4Match[2], 10)
    if (b1 === 10) return true
    if (b1 === 172 && b2 >= 16 && b2 <= 31) return true
    if (b1 === 192 && b2 === 168) return true
    if (b1 === 169 && b2 === 254) return true
    if (b1 === 127) return true
    if (b1 === 0) return true
  }

  return false
}

export interface SSRFConfig {
  enabled: boolean
  allowed_hosts: string[]
}

export function validateBaseUrl(url: string, config: SSRFConfig): { valid: boolean; reason?: string } {
  if (!url) {
    return { valid: false, reason: 'Base URL is required' }
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { valid: false, reason: `Invalid URL format: ${url}` }
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, reason: `Only http/https URLs are allowed, got: ${parsed.protocol}` }
  }

  const hostname = parsed.hostname.toLowerCase()

  // Always block internal/private IPs
  if (isPrivateIP(hostname)) {
    return { valid: false, reason: `Blocked: ${hostname} is a private/internal address` }
  }

  // If SSRF protection is enabled with whitelist, check it
  if (config.enabled && config.allowed_hosts.length > 0) {
    const allowed = config.allowed_hosts.some(h => hostname === h || hostname.endsWith('.' + h))
    if (!allowed) {
      return { valid: false, reason: `Host "${hostname}" is not in the allowed domain list` }
    }
  }

  return { valid: true }
}
