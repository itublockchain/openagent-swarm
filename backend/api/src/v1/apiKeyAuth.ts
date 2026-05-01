import type { FastifyReply, FastifyRequest } from 'fastify'
import type { KeyStore, Scope } from './keystore'

/**
 * Per-request context attached after a successful API key check.
 * Routes downstream of `apiKeyAuth` read this off `request.apiKey`.
 */
export interface ApiKeyContext {
  userAddress: string
  scopes: Scope[]
  /** keccak256(plaintext) — the same bytes32 the user used when calling
   *  `Treasury.bindKey`. Routes pass this into `spendOnBehalfOf` so the
   *  contract verifies key/user binding on every spend. */
  chainKeyHash: `0x${string}`
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyContext
  }
}

interface AuthOpts {
  keyStore: KeyStore
}

/**
 * Builds an onRequest hook that validates a `Authorization: Bearer sk_...`
 * header. On success it stamps `request.apiKey`; on failure it short-
 * circuits with a 401 JSON error. Distinct from the existing SIWE-JWT
 * `requireAuth` in server.ts — that one is for the user-facing webapp,
 * this one is for SDK / CLI consumers using their long-lived API key.
 */
export function apiKeyAuth({ keyStore }: AuthOpts) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      reply.status(401).send({ error: 'Missing API key', code: 'MISSING_KEY' })
      return reply
    }
    const token = header.slice(7).trim()

    const result = keyStore.lookup(token)
    if (!result) {
      reply.status(401).send({ error: 'Invalid or revoked API key', code: 'INVALID_KEY' })
      return reply
    }

    request.apiKey = result
  }
}

/**
 * Hook factory that requires a specific scope on top of `apiKeyAuth`.
 * Mount apiKeyAuth first (or the same hook composes both), then
 * `requireScope('tasks:submit')`.
 */
export function requireScope(scope: Scope) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = request.apiKey
    if (!ctx) {
      // apiKeyAuth wasn't mounted upstream — fail loud during dev
      reply.status(500).send({ error: 'Auth context missing — apiKeyAuth not mounted', code: 'INTERNAL' })
      return reply
    }
    if (!ctx.scopes.includes(scope)) {
      reply.status(403).send({
        error: `Key missing required scope: ${scope}`,
        code: 'SCOPE_DENIED',
        required: scope,
        granted: ctx.scopes,
      })
      return reply
    }
  }
}
