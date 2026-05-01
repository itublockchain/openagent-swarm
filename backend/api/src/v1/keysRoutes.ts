import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { DEFAULT_SCOPES, type KeyStore, type Scope } from './keystore'

const SCOPES = ['tasks:submit', 'tasks:read', 'agents:read'] as const
const ScopeSchema = z.enum(SCOPES)

const CreateKeyBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  scopes: z.array(ScopeSchema).min(1).optional(),
})

interface RegisterOpts {
  keyStore: KeyStore
  /**
   * SIWE-JWT auth check from server.ts. We don't import directly to
   * avoid a circular dep — the host wires it in at registration.
   * Returns the authenticated user or null (after sending 401).
   */
  requireAuth: (
    req: any,
    reply: any,
  ) => { address: string; chainId: number } | null
  /** 'live' for prod chain, 'test' for testnet/dev. */
  env: 'live' | 'test'
}

/**
 * Mounts /v1/keys/* — webapp-driven key management. SDK consumers never
 * hit these; they're the user-facing flow that issues the keys SDK calls
 * present at /v1/* endpoints.
 *
 * All endpoints require the existing SIWE-JWT (NOT API key) — generation
 * must be tied to the actual wallet so we can record the binding.
 */
export async function registerKeysRoutes(app: FastifyInstance, opts: RegisterOpts) {
  const { keyStore, requireAuth, env } = opts

  // POST /v1/keys — generate. Returns the plaintext exactly once.
  app.post('/v1/keys', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return

    const parse = CreateKeyBody.safeParse(request.body)
    if (!parse.success) {
      reply.status(400).send({ error: 'Invalid body', issues: parse.error.issues })
      return
    }
    const scopes: Scope[] = parse.data.scopes ?? DEFAULT_SCOPES
    const { plaintext, chainKeyHash, row } = keyStore.create({
      userAddress: user.address,
      scopes,
      name: parse.data.name ?? null,
      env,
    })
    reply.send({
      key: plaintext, // user must save now — server never returns it again
      // chainKeyHash is the bytes32 the webapp passes to Treasury.bindKey
      // so the on-chain contract gates freeze/spend on this exact value.
      chainKeyHash,
      ...row,
    })
  })

  // GET /v1/keys — list user's keys (no plaintext).
  app.get('/v1/keys', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return
    const rows = keyStore.listForUser(user.address)
    reply.send({ keys: rows })
  })

  // DELETE /v1/keys/:id — revoke. Idempotent on re-call (returns 404 if
  // already revoked or not owned by caller — same response so we don't
  // leak existence to other users).
  app.delete('/v1/keys/:id', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return
    const { id } = request.params as { id: string }
    if (!id || typeof id !== 'string') {
      reply.status(400).send({ error: 'Missing id' })
      return
    }
    const ok = keyStore.revoke(id, user.address)
    if (!ok) {
      reply.status(404).send({ error: 'Key not found or already revoked' })
      return
    }
    reply.send({ ok: true })
  })
}
