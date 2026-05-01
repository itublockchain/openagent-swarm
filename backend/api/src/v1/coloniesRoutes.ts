import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { ColonyStore } from './colonyStore'
import type { TaskIndex } from './tasksIndex'
import type { AgentManager } from '../AgentRunner'
import type { INetworkPort } from '../../../../shared/ports'
import { EventType } from '../../../../shared/types'

/**
 * Auth resolver — returns the authenticated EOA or null. The same route
 * file mounts twice with different resolvers:
 *   - /v1/me/colonies (webapp) → SIWE-JWT resolver (server.ts requireAuth)
 *   - /v1/colonies     (SDK)   → API-key resolver (apiKeyAuth)
 * Both feed the same handlers, so colony semantics stay identical across
 * surfaces and the SQLite store is the single source of truth.
 */
export type AuthResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ address: string } | null>

interface RegisterOpts {
  /** URL prefix this set of routes mounts under (e.g. '/v1/me/colonies'). */
  prefix: string
  store: ColonyStore
  manager: AgentManager
  /** Reads per-colony task aggregates (total/completed/pending) so the
   *  list and detail responses can ship them inline — saves the UI a
   *  second round-trip per colony. */
  taskIndex: TaskIndex
  /** Resolves the calling user's EOA from request auth. Returning null is
   *  the resolver's contract for "rejected — already wrote 401". */
  resolveUser: AuthResolver
  /** AXL gossip bus. addMember/removeMember broadcast a
   *  COLONY_MEMBERSHIP_CHANGED event so SwarmAgent can refresh its local
   *  myColonies set without waiting for the 30s poll — closes the demo
   *  race where a freshly-added member abstained from a colony task. */
  network: INetworkPort
}

const CreateColonyBody = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).optional(),
  visibility: z.enum(['private', 'public']).optional(),
})
const AddMemberBody = z.object({
  agent_id: z.string().trim().min(1),
})
const PatchColonyBody = z.object({
  visibility: z.enum(['private', 'public']),
})

export async function registerColoniesRoutes(app: FastifyInstance, opts: RegisterOpts) {
  const { prefix, store, manager, taskIndex, resolveUser, network } = opts

  const broadcastMembershipChange = (
    colonyId: string,
    agentId: string,
    change: 'added' | 'removed',
  ) => {
    network.emit({
      type: EventType.COLONY_MEMBERSHIP_CHANGED,
      payload: { colonyId, agentId, change },
      timestamp: Date.now(),
      agentId: 'api-server',
    }).catch(err => {
      // Non-fatal: agent will pick up the change on its next 30s poll.
      console.warn('[colonies] membership broadcast failed:', err)
    })
  }

  // ─── List my colonies ─────────────────────────────────────────────
  app.get(`${prefix}`, async (req, reply) => {
    const user = await resolveUser(req, reply)
    if (!user) return
    const rows = store.listForOwner(user.address)
    // Hydrate each colony with its current member count + task stats so
    // the profile UI can render the list without a follow-up call per
    // colony. Stats query is a single COUNT(*) per colony — fine for
    // the small N of colonies a user typically has.
    const out = rows.map(c => {
      const stats = taskIndex.getColonyStats(c.id)
      return {
        id: c.id,
        name: c.name,
        description: c.description,
        visibility: c.visibility,
        owner: c.owner,
        created_at: c.createdAt,
        member_count: store.getMembers(c.id).length,
        task_stats: stats,
      }
    })
    reply.send({ colonies: out })
  })

  // ─── Create colony ────────────────────────────────────────────────
  app.post(`${prefix}`, async (req, reply) => {
    const user = await resolveUser(req, reply)
    if (!user) return
    const parse = CreateColonyBody.safeParse(req.body)
    if (!parse.success) {
      reply.status(400).send({ error: 'Invalid body', issues: parse.error.issues })
      return
    }
    const colony = store.create({
      owner: user.address,
      name: parse.data.name,
      description: parse.data.description ?? null,
      visibility: parse.data.visibility,
    })
    reply.status(201).send({
      id: colony.id,
      name: colony.name,
      description: colony.description,
      visibility: colony.visibility,
      owner: colony.owner,
      created_at: colony.createdAt,
      member_count: 0,
    })
  })

  // ─── Update visibility ────────────────────────────────────────────
  app.patch<{ Params: { id: string } }>(`${prefix}/:id`, async (req, reply) => {
    const user = await resolveUser(req, reply)
    if (!user) return
    const parse = PatchColonyBody.safeParse(req.body)
    if (!parse.success) {
      reply.status(400).send({ error: 'Invalid body', issues: parse.error.issues })
      return
    }
    const check = store.ownerCheck(req.params.id, user.address)
    if (!check.ok) {
      const status = check.reason === 'not_found' || check.reason === 'archived' ? 404 : 403
      reply.status(status).send({ error: check.reason })
      return
    }
    const changed = store.setVisibility(check.colony.id, user.address, parse.data.visibility)
    reply.send({ ok: true, changed, visibility: parse.data.visibility })
  })

  // ─── Colony detail (with members hydrated to AgentManager records) ─
  app.get<{ Params: { id: string } }>(`${prefix}/:id`, async (req, reply) => {
    const user = await resolveUser(req, reply)
    if (!user) return
    const check = store.ownerCheck(req.params.id, user.address)
    if (!check.ok) {
      const status = check.reason === 'not_found' || check.reason === 'archived' ? 404 : 403
      reply.status(status).send({ error: check.reason })
      return
    }
    const memberRefs = store.getMembers(check.colony.id)
    // Hydrate each member with its agent record so the UI can show
    // name/status/balance without per-member lookups. Agents that no
    // longer exist (deleted via DELETE /agent/:id) keep the stub so
    // the user sees the membership and can clean it up.
    let pool: Array<any> = []
    try {
      pool = await manager.list()
    } catch (err) {
      console.warn('[colonies] AgentManager.list failed during detail hydrate:', err)
    }
    const members = memberRefs.map(m => {
      const rec = pool.find(p => p.agentId === m.agentId)
      return {
        agent_id: m.agentId,
        added_at: m.addedAt,
        name: rec?.name ?? null,
        status: rec?.status ?? 'unknown',
        agent_address: rec?.agentAddress ?? null,
      }
    })
    reply.send({
      id: check.colony.id,
      name: check.colony.name,
      description: check.colony.description,
      visibility: check.colony.visibility,
      owner: check.colony.owner,
      created_at: check.colony.createdAt,
      members,
      task_stats: taskIndex.getColonyStats(check.colony.id),
    })
  })

  // ─── Archive (soft delete) ────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(`${prefix}/:id`, async (req, reply) => {
    const user = await resolveUser(req, reply)
    if (!user) return
    const ok = store.archive(req.params.id, user.address)
    if (!ok) {
      reply.status(404).send({ error: 'Colony not found or already archived' })
      return
    }
    reply.send({ ok: true })
  })

  // ─── Add agent to colony ──────────────────────────────────────────
  app.post<{ Params: { id: string } }>(`${prefix}/:id/agents`, async (req, reply) => {
    const user = await resolveUser(req, reply)
    if (!user) return
    const parse = AddMemberBody.safeParse(req.body)
    if (!parse.success) {
      reply.status(400).send({ error: 'Invalid body', issues: parse.error.issues })
      return
    }
    const check = store.ownerCheck(req.params.id, user.address)
    if (!check.ok) {
      const status = check.reason === 'not_found' || check.reason === 'archived' ? 404 : 403
      reply.status(status).send({ error: check.reason })
      return
    }
    // Cross-check: caller can only add agents they own. AgentManager is
    // the authority on agent ownership. Stale agentIds (no secret) are
    // rejected outright — owner-less agents shouldn't appear in any colony.
    const agentMeta = manager.getSecretMeta(parse.data.agent_id)
    if (!agentMeta) {
      reply.status(404).send({ error: 'Agent not found' })
      return
    }
    if (!agentMeta.ownerAddress || agentMeta.ownerAddress.toLowerCase() !== user.address.toLowerCase()) {
      reply.status(403).send({ error: 'You can only add agents you own' })
      return
    }
    const added = store.addMember(check.colony.id, parse.data.agent_id)
    if (added) broadcastMembershipChange(check.colony.id, parse.data.agent_id, 'added')
    reply.send({ ok: true, added })
  })

  // ─── Remove agent from colony ─────────────────────────────────────
  app.delete<{ Params: { id: string; agentId: string } }>(
    `${prefix}/:id/agents/:agentId`,
    async (req, reply) => {
      const user = await resolveUser(req, reply)
      if (!user) return
      const check = store.ownerCheck(req.params.id, user.address)
      if (!check.ok) {
        const status = check.reason === 'not_found' || check.reason === 'archived' ? 404 : 403
        reply.status(status).send({ error: check.reason })
        return
      }
      const removed = store.removeMember(check.colony.id, req.params.agentId)
      if (removed) broadcastMembershipChange(check.colony.id, req.params.agentId, 'removed')
      reply.send({ ok: true, removed })
    },
  )
}
