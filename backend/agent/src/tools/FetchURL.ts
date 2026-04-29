import { ToolResult } from './Tool'
import * as cheerio from 'cheerio'
import { lookup } from 'node:dns/promises'

const MAX_CHARS = 5000
const MAX_BYTES = 2 * 1024 * 1024 // 2 MiB raw response cap
const FETCH_TIMEOUT_MS = 15_000

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

// Hostnames that resolve to internal Docker services on swarm_default.
// Blocked by name before DNS lookup as a fast path; the IP check below also
// catches them, but rejecting cheap.
const BLOCKED_HOSTNAMES = new Set([
  'localhost', '0.0.0.0',
  'api', 'agent', 'axl-seed', 'docker-proxy', 'frontend',
  'host.docker.internal', 'gateway.docker.internal',
])

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true
  const [a, b] = parts
  if (a === 0) return true                              // 0.0.0.0/8
  if (a === 10) return true                             // 10.0.0.0/8
  if (a === 127) return true                            // loopback
  if (a === 169 && b === 254) return true               // link-local / AWS metadata
  if (a === 172 && b >= 16 && b <= 31) return true      // 172.16/12
  if (a === 192 && b === 168) return true               // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true     // CGNAT 100.64/10
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  if (lower.startsWith('fe80:')) return true            // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true     // unique-local fc00::/7
  if (lower.startsWith('::ffff:')) {                    // IPv4-mapped
    const v4 = lower.slice(7)
    return isPrivateIPv4(v4)
  }
  return false
}

/**
 * Resolve hostname to IP and reject internal/loopback ranges.
 * Note: this leaves a tiny DNS-rebinding race window (lookup public, fetch
 * resolves to private) which is acceptable for a demo. To eliminate, we'd
 * need a custom undici dispatcher that pins to the resolved IP.
 */
async function isHostBlocked(hostname: string): Promise<boolean> {
  const lower = hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.has(lower)) return true
  if (lower.endsWith('.local') || lower.endsWith('.internal')) return true

  try {
    const { address, family } = await lookup(hostname)
    return family === 6 ? isPrivateIPv6(address) : isPrivateIPv4(address)
  } catch {
    return true // DNS failure → fail-closed
  }
}

/**
 * Stream-read a Response body, capping at maxBytes. Returns null if the
 * cap is exceeded so the caller can abort the request and surface 'too_large'.
 * Stops reading at the cap rather than buffering everything — matters for
 * adversarial servers that lie about Content-Length.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const reader = res.body?.getReader()
  if (!reader) return await res.text() // no streamable body, fall back

  const decoder = new TextDecoder()
  let total = 0
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      try { await reader.cancel() } catch {}
      return null
    }
    out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}

/**
 * Fetch an arbitrary URL and return its visible text. Cheerio strips scripts,
 * styles, and noscript before serializing — what's left is rough but
 * LLM-edible. Output capped at MAX_CHARS to stay within the model's budget.
 */
export async function fetchURL(url: string): Promise<ToolResult> {
  if (!url.trim()) {
    return { ok: false, output: 'fetch_url: empty url', error: 'empty_url' }
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, output: `fetch_url: invalid URL "${url}"`, error: 'invalid_url' }
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      output: `fetch_url: unsupported protocol "${parsed.protocol}". Only http/https allowed.`,
      error: 'bad_protocol',
    }
  }

  if (await isHostBlocked(parsed.hostname)) {
    return {
      ok: false,
      output: `fetch_url: host "${parsed.hostname}" is internal/private and blocked (SSRF protection).`,
      error: 'blocked_host',
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const res = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Identify ourselves; some sites refuse blank UAs.
        'User-Agent': 'SwarmAgent/1.0 (+https://github.com/swarm)',
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
    })
    if (!res.ok) {
      return { ok: false, output: `fetch_url: HTTP ${res.status} ${res.statusText}`, error: `http_${res.status}` }
    }

    // Reject responses larger than MAX_BYTES via Content-Length when honest,
    // and via streaming byte count when not.
    const contentLength = Number(res.headers.get('content-length') ?? 0)
    if (contentLength && contentLength > MAX_BYTES) {
      controller.abort()
      return {
        ok: false,
        output: `fetch_url: response too large (${contentLength} bytes, cap ${MAX_BYTES})`,
        error: 'too_large',
      }
    }

    const contentType = res.headers.get('content-type') ?? ''
    const raw = await readCapped(res, MAX_BYTES)
    if (raw === null) {
      controller.abort()
      return { ok: false, output: `fetch_url: response exceeded ${MAX_BYTES} bytes`, error: 'too_large' }
    }

    // Plain text passthrough — cheerio would just wrap it pointlessly.
    if (contentType.includes('text/plain') || contentType.includes('application/json')) {
      const trimmed = raw.slice(0, MAX_CHARS)
      return {
        ok: true,
        output: `${parsed.toString()}\nContent-Type: ${contentType}\n\n${trimmed}`,
        data: { url: parsed.toString(), contentType, chars: trimmed.length, truncated: raw.length > MAX_CHARS },
      }
    }

    const $ = cheerio.load(raw)
    $('script, style, noscript, iframe, svg').remove()
    const title = $('title').first().text().trim()
    // Prefer <main> / <article> body if present, else fall back to body text.
    const root = $('main').first().length ? $('main').first()
      : $('article').first().length ? $('article').first()
      : $('body')
    const text = root.text().replace(/\s+/g, ' ').trim()
    const truncated = text.length > MAX_CHARS
    const slice = text.slice(0, MAX_CHARS)

    return {
      ok: true,
      output: `${parsed.toString()}\n${title ? `Title: ${title}\n` : ''}\n${slice}${truncated ? '\n[...truncated]' : ''}`,
      data: { url: parsed.toString(), title, chars: slice.length, truncated },
    }
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? 'request timeout' : (err?.message ?? String(err))
    return { ok: false, output: `fetch_url failed: ${msg}`, error: msg }
  } finally {
    clearTimeout(timer)
  }
}
