import { ENV } from './env'

const API_URL = ENV.API_URL

/** Custom event AuthContext listens for to flush its in-memory JWT state
 *  the moment the backend rejects a stored token. Stays in lib/ to avoid
 *  pulling React into the fetch helper. */
export const AUTH_EXPIRED_EVENT = 'swarm:auth-expired'

/** Fired by any flow that hits an insufficient-balance backend response.
 *  Header listens and pops the DepositModal so the user lands directly on
 *  the fix instead of reading a "go open the deposit modal" instruction. */
export const OPEN_DEPOSIT_EVENT = 'spore:open-deposit'

/** Convenience helper — keeps call sites a one-liner and avoids importing
 *  the constant separately wherever they detect insufficient balance. */
export function openDepositModal(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(OPEN_DEPOSIT_EVENT))
}

export async function apiRequest(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const jwt = typeof window !== 'undefined' ? localStorage.getItem('spore_jwt') : null

  // Only stamp Content-Type when there's actually a body. Fastify's default
  // JSON content-type-parser throws a 400 (FST_ERR_CTP_EMPTY_JSON_BODY) on
  // body-less requests that still announce application/json — every DELETE
  // / GET routed through this helper used to hit that even though the
  // server-side handler had no body parsing at all.
  const hasBody = options.body !== undefined && options.body !== null
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      ...options.headers,
    },
  })

  // If we sent a token and the backend rejected it as invalid (JWT_SECRET
  // rotated, signature mismatch, expired), wipe the stale token and let
  // AuthContext reopen the wallet gate. Without this the app silently
  // 401s on every request while the user stays "logged in" in the UI.
  if (res.status === 401 && jwt && typeof window !== 'undefined') {
    localStorage.removeItem('swarm_jwt')
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
  }

  return res
}
