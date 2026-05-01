const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

/** Custom event AuthContext listens for to flush its in-memory JWT state
 *  the moment the backend rejects a stored token. Stays in lib/ to avoid
 *  pulling React into the fetch helper. */
export const AUTH_EXPIRED_EVENT = 'swarm:auth-expired'

export async function apiRequest(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const jwt = typeof window !== 'undefined' ? localStorage.getItem('spore_jwt') : null

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
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
