import type { FastifyInstance } from 'fastify'
import { apiKeyAuth, requireScope } from './apiKeyAuth'
import type { KeyStore } from './keystore'
import type { AgentManager } from '../AgentRunner'

interface RegisterOpts {
  keyStore: KeyStore
  manager: AgentManager
}

/**
 * GET /v1/agents — read-only pool view, scoped behind `agents:read`.
 *
 * Wraps the existing manager.list() output (already shape-compatible with
 * what the webapp's pool view consumes), so SDK callers see the same set
 * of agents the explorer shows.
 */
export async function registerAgentsRoutes(app: FastifyInstance, opts: RegisterOpts) {
  const auth = apiKeyAuth({ keyStore: opts.keyStore })
  const scope = requireScope('agents:read')

  app.get('/v1/agents', { onRequest: [auth, scope] }, async (_request, reply) => {
    const agents = await opts.manager.list()
    reply.send({ agents })
  })
}
