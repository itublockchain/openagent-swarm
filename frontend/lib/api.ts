const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

export async function apiRequest(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const jwt = typeof window !== 'undefined' ? localStorage.getItem('spore_jwt') : null

  return fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      ...options.headers,
    },
  })
}
